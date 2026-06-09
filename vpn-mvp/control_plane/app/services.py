from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import BillingEvent, Device, DeviceStatus, DeviceUsageDaily, Node, NodeStatus, Payment, PaymentStatus, User, UserStatus
from app.security import decrypt_secret, encrypt_secret
from app.task_queue import enqueue_edge_command
from app.awg import new_pending_secret, normalize_client_conf


settings = get_settings()


def get_or_create_user(db: Session, telegram_id: int, username: str | None, first_name: str | None) -> User:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    if user:
        if username and user.username != username:
            user.username = username
        if first_name and user.first_name != first_name:
            user.first_name = first_name
        db.commit()
        db.refresh(user)
        return user

    user = User(telegram_id=telegram_id, username=username, first_name=first_name)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def choose_node(db: Session, exclude_node_id: int | None = None, exclude_node_ids: set[int] | None = None) -> Node:
    stmt = (
        select(Node)
        .where(Node.status == NodeStatus.healthy)
        .where(Node.active_clients < Node.max_clients)
        .order_by(Node.active_clients.asc(), Node.id.asc())
    )
    excluded = set(exclude_node_ids or set())
    if exclude_node_id is not None:
        excluded.add(exclude_node_id)
    if excluded:
        stmt = stmt.where(Node.id.notin_(excluded))

    if exclude_node_id is not None:
        preferred = db.scalar(stmt)
        if preferred:
            return preferred

    node = db.scalar(stmt)
    if not node:
        raise HTTPException(status_code=503, detail='No healthy nodes available')
    return node


def calculate_balance_stats(db: Session, user: User) -> dict:
    active_devices = db.scalar(select(func.count(Device.id)).where(Device.user_id == user.id, Device.status == DeviceStatus.active)) or 0
    daily = active_devices * settings.daily_device_price_kopecks
    days_left = None
    if daily > 0:
        days_left = user.balance_kopecks // daily
    return {
        'balance_kopecks': user.balance_kopecks,
        'active_devices': active_devices,
        'daily_charge_kopecks': daily,
        'days_left': days_left,
    }


def ensure_user_can_add_device(user: User) -> None:
    if user.status == UserStatus.banned:
        raise HTTPException(status_code=403, detail='User is banned')
    if user.balance_kopecks <= 0:
        raise HTTPException(status_code=400, detail='Insufficient balance to add a device')


def push_peer_command(node: Node, method: str, path: str, payload: dict | None = None) -> dict:
    url = f'{node.api_url}{path}'
    headers = {'X-Edge-Token': node.token}
    with httpx.Client(timeout=10.0) as client:
        response = client.request(method=method, url=url, headers=headers, json=payload)
    if response.status_code >= 300:
        raise HTTPException(status_code=502, detail=f'Edge node command failed: {response.text}')
    if response.content:
        return response.json()
    return {}


def queue_peer_command(
    node: Node,
    method: str,
    path: str,
    payload: dict | None = None,
    post_success: dict[str, Any] | None = None,
) -> None:
    enqueue_edge_command(
        node_id=node.id,
        method=method,
        path=path,
        payload=payload or {},
        post_success=post_success,
    )


def create_device_for_user(db: Session, user: User, name: str) -> dict:
    ensure_user_can_add_device(user)
    user_id = user.id
    failed_node_ids: set[int] = set()
    last_error: Exception | None = None

    while True:
        try:
            node = choose_node(db, exclude_node_ids=failed_node_ids)
        except HTTPException:
            if last_error:
                raise HTTPException(status_code=502, detail='Failed to create device on available edge nodes') from last_error
            raise

        pending_secret = new_pending_secret()
        device = Device(
            user_id=user_id,
            node_id=node.id,
            name=name,
            vpn_ip=f'awg-pending-{pending_secret}',
            public_key=f'awg-pending-{pending_secret}',
            private_key_encrypted=encrypt_secret(pending_secret),
            status=DeviceStatus.active,
        )
        db.add(device)
        db.flush()

        try:
            edge_result = push_peer_command(
                node,
                method='POST',
                path='/peers',
                payload={'device_id': device.id, 'name': device.name},
            )

            conf_text = normalize_client_conf(edge_result['conf_text'])
            device.vpn_ip = edge_result['vpn_ip']
            device.public_key = edge_result['public_key']
            device.private_key_encrypted = encrypt_secret(conf_text)
            node.active_clients = (node.active_clients or 0) + 1
            db.commit()
            db.refresh(device)

            return {
                'device': device,
                'conf_text': conf_text,
                'qr_png_base64': edge_result['qr_png_base64'],
            }
        except Exception as error:
            failed_node_ids.add(node.id)
            last_error = error
            device_id = device.id
            db.rollback()
            try:
                push_peer_command(node, method='DELETE', path=f'/peers/{device_id}')
            except Exception:
                pass


def regenerate_device_config(db: Session, device: Device) -> dict:
    old_node = device.node
    node = choose_node(db, exclude_node_id=old_node.id if old_node else None)

    edge_result = push_peer_command(
        node,
        method='POST',
        path='/peers',
        payload={'device_id': device.id, 'name': device.name},
    )

    conf_text = normalize_client_conf(edge_result['conf_text'])
    device.node_id = node.id
    device.vpn_ip = edge_result['vpn_ip']
    device.public_key = edge_result['public_key']
    device.private_key_encrypted = encrypt_secret(conf_text)
    if old_node and old_node.id != node.id:
        if old_node.active_clients > 0:
            old_node.active_clients -= 1
        node.active_clients = (node.active_clients or 0) + 1
    db.commit()
    db.refresh(device)

    if old_node and old_node.id != node.id:
        try:
            push_peer_command(old_node, method='DELETE', path=f'/peers/{device.id}')
        except Exception:
            pass

    return {'conf_text': conf_text, 'qr_png_base64': edge_result['qr_png_base64']}


def delete_device(db: Session, device: Device) -> None:
    if device.status == DeviceStatus.deleted:
        return
    push_peer_command(device.node, method='DELETE', path=f'/peers/{device.id}')
    device.status = DeviceStatus.deleted
    device.revoked_at = datetime.now(UTC)
    if device.node.active_clients > 0:
        device.node.active_clients -= 1
    db.commit()


def mark_payment_confirmed(
    db: Session,
    user: User,
    amount_kopecks: int,
    external_payment_id: str | None = None,
    provider: str = 'telegram',
) -> Payment:
    if external_payment_id:
        existing = db.scalar(select(Payment).where(Payment.external_payment_id == external_payment_id))
        if existing:
            return existing

    payment = Payment(
        user_id=user.id,
        provider=provider,
        amount_kopecks=amount_kopecks,
        currency='RUB',
        status=PaymentStatus.confirmed,
        external_payment_id=external_payment_id,
        confirmed_at=datetime.now(UTC),
    )
    user.balance_kopecks += amount_kopecks
    db.add(payment)
    db.add(
        BillingEvent(
            user_id=user.id,
            amount_kopecks=amount_kopecks,
            event_type='topup',
            description=f'Topup +{amount_kopecks} kopecks',
        )
    )
    db.commit()
    db.refresh(payment)
    resume_user_devices_if_possible(db, user)
    return payment


def suspend_user_devices(db: Session, user: User, reason: str = 'insufficient funds') -> None:
    active_devices = db.scalars(select(Device).where(Device.user_id == user.id, Device.status == DeviceStatus.active)).all()
    for device in active_devices:
        queue_peer_command(
            device.node,
            method='POST',
            path=f'/peers/{device.id}/suspend',
            payload={'reason': reason},
            post_success={'type': 'device_status', 'device_id': device.id, 'status': DeviceStatus.suspended.value},
        )


def resume_user_devices_if_possible(db: Session, user: User) -> None:
    if user.status == UserStatus.banned:
        return
    suspended_devices = db.scalars(select(Device).where(Device.user_id == user.id, Device.status == DeviceStatus.suspended)).all()
    if not suspended_devices or user.balance_kopecks <= 0:
        return
    for device in suspended_devices:
        queue_peer_command(
            device.node,
            method='POST',
            path=f'/peers/{device.id}/resume',
            payload={},
            post_success={'type': 'device_status', 'device_id': device.id, 'status': DeviceStatus.active.value},
        )


def run_daily_billing(db: Session) -> dict:
    charged_users = 0
    suspended_users = 0
    users = db.scalars(select(User).where(User.status == UserStatus.active)).all()

    for user in users:
        active_count = db.scalar(select(func.count(Device.id)).where(Device.user_id == user.id, Device.status == DeviceStatus.active)) or 0
        if active_count == 0:
            continue
        charge = active_count * settings.daily_device_price_kopecks
        if user.balance_kopecks >= charge:
            user.balance_kopecks -= charge
            db.add(
                BillingEvent(
                    user_id=user.id,
                    amount_kopecks=-charge,
                    event_type='daily_charge',
                    description=f'{active_count} active devices x {settings.daily_device_price_kopecks}',
                )
            )
            charged_users += 1
        else:
            suspend_user_devices(db, user, reason='insufficient funds')
            suspended_users += 1
    db.commit()
    return {'charged_users': charged_users, 'suspended_users': suspended_users}


def mark_offline_nodes(db: Session) -> int:
    cutoff = datetime.now(UTC) - timedelta(seconds=settings.node_heartbeat_timeout_sec)
    updated = 0
    nodes = db.scalars(select(Node)).all()
    for node in nodes:
        if not node.last_heartbeat_at or node.last_heartbeat_at < cutoff:
            if node.status != NodeStatus.offline:
                node.status = NodeStatus.offline
                updated += 1
        elif node.status == NodeStatus.offline:
            node.status = NodeStatus.healthy
            updated += 1
    db.commit()
    return updated


def update_device_usage(db: Session, node: Node, usage_rows: list[dict]) -> None:
    today = date.today()
    for row in usage_rows:
        device = db.get(Device, row['device_id'])
        if not device or device.node_id != node.id:
            continue
        usage = db.scalar(
            select(DeviceUsageDaily).where(DeviceUsageDaily.device_id == device.id, DeviceUsageDaily.date == today)
        )
        if not usage:
            usage = DeviceUsageDaily(device_id=device.id, date=today, rx_bytes=0, tx_bytes=0)
            db.add(usage)
        usage.rx_bytes += int(row.get('rx_bytes', 0))
        usage.tx_bytes += int(row.get('tx_bytes', 0))
    db.commit()


def device_total_usage(db: Session, device_id: int) -> tuple[int, int]:
    rx = db.scalar(select(func.coalesce(func.sum(DeviceUsageDaily.rx_bytes), 0)).where(DeviceUsageDaily.device_id == device_id)) or 0
    tx = db.scalar(select(func.coalesce(func.sum(DeviceUsageDaily.tx_bytes), 0)).where(DeviceUsageDaily.device_id == device_id)) or 0
    return int(rx), int(tx)


def get_device_private_key(device: Device) -> str:
    return decrypt_secret(device.private_key_encrypted)
