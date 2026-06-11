from datetime import UTC, datetime

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.auth import get_node_by_token_for_node, require_admin_token, require_internal_token
from app.config import get_settings
from app.db import Base, engine, get_db
from app.models import AuditLog, Device, DeviceStatus, DeviceUsageDaily, Node, NodeStatus, Payment, PaymentStatus, User, UserStatus
from app.schemas import (
    AdminBanIn,
    BalanceOut,
    CreateOrGetUserIn,
    DeviceCreateIn,
    DeviceCreateOut,
    DeviceOut,
    DeviceRenameIn,
    ExternalPaymentConfirmIn,
    HeartbeatIn,
    HealthResponse,
    NodeRegisterIn,
    NodeRegisterOut,
    NodeUsageIn,
    PaymentCreateIn,
    PaymentOut,
    PeerCreateIn,
    UserProfileOut,
)
from app.services import (
    calculate_balance_stats,
    create_device_for_user,
    delete_device,
    device_total_usage,
    get_or_create_user,
    mark_payment_confirmed,
    queue_peer_command,
    reconcile_node_peers,
    regenerate_device_config,
    run_daily_billing,
    update_device_usage,
)

app = FastAPI(title="VPN Control Plane MVP", version="0.1.0")
settings = get_settings()


@app.on_event("startup")
def on_startup() -> None:
    if settings.auto_create_schema:
        Base.metadata.create_all(bind=engine)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/v1/users", response_model=UserProfileOut)
def upsert_user(
    payload: CreateOrGetUserIn,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> UserProfileOut:
    user = get_or_create_user(db, payload.telegram_id, payload.username, payload.first_name)
    return UserProfileOut(
        id=user.id,
        telegram_id=user.telegram_id,
        username=user.username,
        first_name=user.first_name,
        status=user.status.value,
        balance_kopecks=user.balance_kopecks,
    )


@app.get("/v1/users/{telegram_id}/profile", response_model=UserProfileOut)
def get_profile(
    telegram_id: int,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> UserProfileOut:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserProfileOut(
        id=user.id,
        telegram_id=user.telegram_id,
        username=user.username,
        first_name=user.first_name,
        status=user.status.value,
        balance_kopecks=user.balance_kopecks,
    )


@app.get("/v1/users/{telegram_id}/balance", response_model=BalanceOut)
def get_balance(
    telegram_id: int,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> BalanceOut:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return BalanceOut(**calculate_balance_stats(db, user))


@app.post("/v1/payments/mock/confirm", response_model=PaymentOut)
def confirm_payment(
    payload: PaymentCreateIn,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> PaymentOut:
    if not settings.allow_mock_payments:
        raise HTTPException(status_code=403, detail="Mock payments are disabled")
    if payload.amount_rub not in {10, 50, 100}:
        raise HTTPException(status_code=400, detail="Unsupported amount")
    user = db.scalar(select(User).where(User.telegram_id == payload.telegram_id))
    if not user:
        user = get_or_create_user(db, payload.telegram_id, None, None)

    payment = mark_payment_confirmed(
        db,
        user,
        amount_kopecks=payload.amount_rub * 100,
        external_payment_id=payload.external_payment_id,
    )
    return PaymentOut(
        id=payment.id,
        amount_kopecks=payment.amount_kopecks,
        currency=payment.currency,
        status=payment.status.value,
    )


@app.post("/v1/payments/external/confirm", response_model=PaymentOut)
def confirm_external_payment(
    payload: ExternalPaymentConfirmIn,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> PaymentOut:
    user = db.scalar(select(User).where(User.telegram_id == payload.telegram_id))
    if not user:
        user = get_or_create_user(db, payload.telegram_id, None, None)

    payment = mark_payment_confirmed(
        db,
        user,
        amount_kopecks=payload.amount_kopecks,
        external_payment_id=payload.external_payment_id,
        provider=payload.provider,
    )
    return PaymentOut(
        id=payment.id,
        amount_kopecks=payment.amount_kopecks,
        currency=payment.currency,
        status=payment.status.value,
    )


@app.get("/v1/users/{telegram_id}/devices", response_model=list[DeviceOut])
def list_devices(
    telegram_id: int,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> list[DeviceOut]:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    devices = db.scalars(
        select(Device)
        .options(joinedload(Device.node))
        .where(Device.user_id == user.id, Device.status != DeviceStatus.deleted)
        .order_by(Device.created_at.desc())
    ).all()

    result = []
    for device in devices:
        rx, tx = device_total_usage(db, device.id)
        result.append(
            DeviceOut(
                id=device.id,
                name=device.name,
                status=device.status.value,
                node_name=device.node.name,
                country_code=device.node.country_code,
                city=device.node.city,
                vpn_ip=device.vpn_ip,
                created_at=device.created_at,
                rx_bytes=rx,
                tx_bytes=tx,
            )
        )
    return result


@app.get("/v1/devices/by-vpn-ip/{vpn_ip}")
def find_device_by_vpn_ip(
    vpn_ip: str,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> dict:
    device = db.scalar(
        select(Device)
        .options(joinedload(Device.user), joinedload(Device.node))
        .where(Device.vpn_ip == vpn_ip, Device.status == DeviceStatus.active)
    )
    if not device:
        raise HTTPException(status_code=404, detail="Active device not found")
    if device.user.status != UserStatus.active:
        raise HTTPException(status_code=403, detail="User is not active")

    return {
        "user": {
            "telegram_id": device.user.telegram_id,
            "username": device.user.username,
            "first_name": device.user.first_name,
            "status": device.user.status.value,
        },
        "device": {
            "id": device.id,
            "name": device.name,
            "vpn_ip": device.vpn_ip,
            "status": device.status.value,
            "node_name": device.node.name if device.node else None,
        },
    }


@app.post("/v1/devices", response_model=DeviceCreateOut)
def create_device(
    payload: DeviceCreateIn,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> DeviceCreateOut:
    user = db.scalar(select(User).where(User.telegram_id == payload.telegram_id))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    created = create_device_for_user(db, user, payload.name)
    device = created["device"]
    return DeviceCreateOut(
        device_id=device.id,
        node_id=device.node_id,
        conf_text=created["conf_text"],
        conf_filename=f"device-{device.id}-amneziawg.conf",
        qr_png_base64=created["qr_png_base64"],
    )


@app.post("/v1/devices/{device_id}/regenerate", response_model=DeviceCreateOut)
def regenerate_config(
    device_id: int,
    telegram_id: int,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> DeviceCreateOut:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    device = db.scalar(select(Device).options(joinedload(Device.node)).where(Device.id == device_id))
    if not user or not device or device.user_id != user.id:
        raise HTTPException(status_code=404, detail="Device not found")
    generated = regenerate_device_config(db, device)
    return DeviceCreateOut(
        device_id=device.id,
        node_id=device.node_id,
        conf_text=generated["conf_text"],
        conf_filename=f"device-{device.id}-amneziawg.conf",
        qr_png_base64=generated["qr_png_base64"],
    )


@app.patch("/v1/devices/{device_id}")
def rename_device(
    device_id: int,
    telegram_id: int,
    payload: DeviceRenameIn,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> dict:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    device = db.scalar(select(Device).where(Device.id == device_id))
    if not user or not device or device.user_id != user.id:
        raise HTTPException(status_code=404, detail="Device not found")
    device.name = payload.name
    db.commit()
    return {"status": "ok"}


@app.delete("/v1/devices/{device_id}")
def remove_device(
    device_id: int,
    telegram_id: int,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> dict:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    device = db.scalar(select(Device).options(joinedload(Device.node)).where(Device.id == device_id))
    if not user or not device or device.user_id != user.id:
        raise HTTPException(status_code=404, detail="Device not found")
    delete_device(db, device)
    return {"status": "ok"}


@app.post("/v1/admin/users/{telegram_id}/ban")
def ban_user(
    telegram_id: int,
    payload: AdminBanIn,
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> dict:
    user = db.scalar(select(User).where(User.telegram_id == telegram_id))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.status = UserStatus.banned
    devices = db.scalars(select(Device).options(joinedload(Device.node)).where(Device.user_id == user.id)).all()
    for device in devices:
        if device.status in {DeviceStatus.active, DeviceStatus.suspended}:
            queue_peer_command(
                device.node,
                method="POST",
                path=f"/peers/{device.id}/suspend",
                payload={"reason": payload.reason},
                post_success={"type": "device_status", "device_id": device.id, "status": DeviceStatus.banned.value},
            )
    db.add(
        AuditLog(
            actor_type="admin",
            actor_id="internal",
            entity_type="user",
            entity_id=str(user.id),
            action="ban_user",
            payload_json={"reason": payload.reason},
        )
    )
    db.commit()
    return {"status": "ok"}


@app.post("/v1/admin/devices/{device_id}/ban")
def ban_device(
    device_id: int,
    payload: AdminBanIn,
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> dict:
    device = db.scalar(select(Device).options(joinedload(Device.node)).where(Device.id == device_id))
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.status in {DeviceStatus.active, DeviceStatus.suspended}:
        queue_peer_command(
            device.node,
            method="POST",
            path=f"/peers/{device.id}/suspend",
            payload={"reason": payload.reason},
            post_success={"type": "device_status", "device_id": device.id, "status": DeviceStatus.banned.value},
        )
    else:
        device.status = DeviceStatus.banned
    db.add(
        AuditLog(
            actor_type="admin",
            actor_id="internal",
            entity_type="device",
            entity_id=str(device.id),
            action="ban_device",
            payload_json={"reason": payload.reason},
        )
    )
    db.commit()
    return {"status": "ok"}


@app.get("/v1/nodes")
def list_nodes(
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> list[dict]:
    nodes = db.scalars(select(Node).order_by(Node.id.asc())).all()
    return [
        {
            "id": node.id,
            "name": node.name,
            "status": node.status.value,
            "active_clients": node.active_clients,
            "max_clients": node.max_clients,
            "last_heartbeat_at": node.last_heartbeat_at,
            "country_code": node.country_code,
            "city": node.city,
        }
        for node in nodes
    ]


@app.get("/v1/admin/users")
def admin_list_users(
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> list[dict]:
    users = db.scalars(select(User).order_by(User.created_at.desc())).all()
    return [
        {
            "id": u.id,
            "telegram_id": u.telegram_id,
            "username": u.username,
            "first_name": u.first_name,
            "status": u.status.value,
            "balance_kopecks": u.balance_kopecks,
            "created_at": u.created_at,
            "updated_at": u.updated_at,
        }
        for u in users
    ]


@app.get("/v1/admin/payments")
def admin_list_payments(
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> list[dict]:
    payments = db.scalars(select(Payment).order_by(Payment.created_at.desc())).all()
    return [
        {
            "id": p.id,
            "user_id": p.user_id,
            "provider": p.provider,
            "external_payment_id": p.external_payment_id,
            "amount_kopecks": p.amount_kopecks,
            "currency": p.currency,
            "status": p.status.value,
            "created_at": p.created_at,
            "confirmed_at": p.confirmed_at,
        }
        for p in payments
    ]


@app.get("/v1/admin/devices")
def admin_list_devices(
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> list[dict]:
    devices = db.scalars(select(Device).options(joinedload(Device.node)).order_by(Device.created_at.desc())).all()
    return [
        {
            "id": d.id,
            "user_id": d.user_id,
            "node_id": d.node_id,
            "node_name": d.node.name if d.node else None,
            "name": d.name,
            "status": d.status.value,
            "vpn_ip": d.vpn_ip,
            "created_at": d.created_at,
            "updated_at": d.updated_at,
            "revoked_at": d.revoked_at,
        }
        for d in devices
    ]


@app.get("/v1/admin/usage/devices")
def admin_usage_devices(
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> list[dict]:
    usage_rows = db.scalars(select(DeviceUsageDaily).order_by(DeviceUsageDaily.date.desc(), DeviceUsageDaily.device_id.asc())).all()
    return [
        {
            "device_id": row.device_id,
            "date": row.date,
            "rx_bytes": row.rx_bytes,
            "tx_bytes": row.tx_bytes,
        }
        for row in usage_rows
    ]


@app.get("/v1/admin/usage/nodes")
def admin_usage_nodes(
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> list[dict]:
    nodes = db.scalars(select(Node).options(joinedload(Node.devices)).order_by(Node.id.asc())).all()
    result = []
    for node in nodes:
        node_rx = 0
        node_tx = 0
        for device in node.devices:
            rx, tx = device_total_usage(db, device.id)
            node_rx += rx
            node_tx += tx
        result.append(
            {
                "node_id": node.id,
                "node_name": node.name,
                "status": node.status.value,
                "active_clients": node.active_clients,
                "max_clients": node.max_clients,
                "rx_bytes_total": node_rx,
                "tx_bytes_total": node_tx,
                "last_heartbeat_at": node.last_heartbeat_at,
            }
        )
    return result


@app.get("/v1/admin/overview")
def admin_overview(
    _: None = Depends(require_admin_token),
    db: Session = Depends(get_db),
) -> dict:
    users = db.scalars(select(User)).all()
    nodes = db.scalars(select(Node).order_by(Node.id.asc())).all()
    devices = db.scalars(select(Device)).all()
    payments = db.scalars(select(Payment)).all()
    usage_rows = db.scalars(select(DeviceUsageDaily)).all()

    users_by_id = {user.id: user for user in users}
    devices_by_id = {device.id: device for device in devices}
    referral_bonus_by_user: dict[int, int] = {}
    for payment in payments:
        if payment.provider == "referral" and payment.status == PaymentStatus.confirmed:
            referral_bonus_by_user[payment.user_id] = referral_bonus_by_user.get(payment.user_id, 0) + int(payment.amount_kopecks)

    total_balance = sum(int(user.balance_kopecks) for user in users)
    positive_balance = sum(max(int(user.balance_kopecks), 0) for user in users)
    bonus_balance = sum(
        min(max(int(user.balance_kopecks), 0), referral_bonus_by_user.get(user.id, 0))
        for user in users
    )

    device_counts_by_node: dict[int, dict] = {
        node.id: {
            "node_id": node.id,
            "node_name": node.name,
            "status": node.status.value,
            "active": 0,
            "suspended": 0,
            "banned": 0,
            "deleted": 0,
            "total": 0,
        }
        for node in nodes
    }
    for device in devices:
        bucket = device_counts_by_node.setdefault(
            device.node_id,
            {
                "node_id": device.node_id,
                "node_name": f"node-{device.node_id}",
                "status": "unknown",
                "active": 0,
                "suspended": 0,
                "banned": 0,
                "deleted": 0,
                "total": 0,
            },
        )
        bucket[device.status.value] = bucket.get(device.status.value, 0) + 1
        bucket["total"] += 1

    traffic_by_node: dict[int, dict] = {
        node.id: {
            "node_id": node.id,
            "node_name": node.name,
            "rx_bytes": 0,
            "tx_bytes": 0,
            "total_bytes": 0,
        }
        for node in nodes
    }
    traffic_by_day: dict[str, dict] = {}
    for row in usage_rows:
        device = devices_by_id.get(row.device_id)
        if not device:
            continue
        node_bucket = traffic_by_node.setdefault(
            device.node_id,
            {"node_id": device.node_id, "node_name": f"node-{device.node_id}", "rx_bytes": 0, "tx_bytes": 0, "total_bytes": 0},
        )
        node_bucket["rx_bytes"] += int(row.rx_bytes)
        node_bucket["tx_bytes"] += int(row.tx_bytes)
        node_bucket["total_bytes"] += int(row.rx_bytes) + int(row.tx_bytes)

        day_key = row.date.isoformat()
        day_bucket = traffic_by_day.setdefault(day_key, {"date": day_key, "rx_bytes": 0, "tx_bytes": 0, "total_bytes": 0})
        day_bucket["rx_bytes"] += int(row.rx_bytes)
        day_bucket["tx_bytes"] += int(row.tx_bytes)
        day_bucket["total_bytes"] += int(row.rx_bytes) + int(row.tx_bytes)

    payments_by_day: dict[str, dict] = {}
    payments_by_provider: dict[str, dict] = {}
    payments_by_status: dict[str, dict] = {}
    for payment in payments:
        day = payment.confirmed_at or payment.created_at
        day_key = day.date().isoformat() if day else "unknown"
        day_bucket = payments_by_day.setdefault(day_key, {"date": day_key, "count": 0, "amount_kopecks": 0})
        day_bucket["count"] += 1
        if payment.status == PaymentStatus.confirmed:
            day_bucket["amount_kopecks"] += int(payment.amount_kopecks)

        provider_bucket = payments_by_provider.setdefault(payment.provider, {"provider": payment.provider, "count": 0, "amount_kopecks": 0})
        provider_bucket["count"] += 1
        if payment.status == PaymentStatus.confirmed:
            provider_bucket["amount_kopecks"] += int(payment.amount_kopecks)

        status_bucket = payments_by_status.setdefault(payment.status.value, {"status": payment.status.value, "count": 0, "amount_kopecks": 0})
        status_bucket["count"] += 1
        status_bucket["amount_kopecks"] += int(payment.amount_kopecks)

    edge_availability = []
    with httpx.Client(timeout=3.0) as client:
        for node in nodes:
            available = False
            latency_ms = None
            error_text = None
            checked_at = datetime.now(UTC)
            try:
                started_at = datetime.now(UTC)
                response = client.get(f"{node.api_url.rstrip('/')}/health")
                latency_ms = round((datetime.now(UTC) - started_at).total_seconds() * 1000)
                available = response.status_code < 300
                if not available:
                    error_text = f"HTTP {response.status_code}"
            except Exception as error:  # noqa: BLE001
                error_text = str(error)
            edge_availability.append(
                {
                    "node_id": node.id,
                    "node_name": node.name,
                    "api_url": node.api_url,
                    "status": node.status.value,
                    "available": available,
                    "latency_ms": latency_ms,
                    "error": error_text,
                    "last_heartbeat_at": node.last_heartbeat_at,
                    "checked_at": checked_at,
                }
            )

    active_users = [user for user in users if user.status == UserStatus.active]
    return {
        "generated_at": datetime.now(UTC),
        "accounts": {
            "total": len(users),
            "active": len(active_users),
            "banned": len(users) - len(active_users),
            "test": sum(1 for user in users if user.test),
            "with_positive_balance": sum(1 for user in users if user.balance_kopecks > 0),
        },
        "balances": {
            "total_kopecks": total_balance,
            "positive_total_kopecks": positive_balance,
            "bonus_balance_kopecks": bonus_balance,
            "average_kopecks": round(total_balance / len(users)) if users else 0,
            "average_positive_kopecks": round(positive_balance / len(users)) if users else 0,
        },
        "devices": {
            "total": len(devices),
            "active": sum(1 for device in devices if device.status == DeviceStatus.active),
            "non_deleted": sum(1 for device in devices if device.status != DeviceStatus.deleted),
            "by_node": list(device_counts_by_node.values()),
        },
        "traffic": {
            "by_node": list(traffic_by_node.values()),
            "by_day": sorted(traffic_by_day.values(), key=lambda item: item["date"]),
        },
        "nodes": edge_availability,
        "payments": {
            "total_count": len(payments),
            "confirmed_count": sum(1 for payment in payments if payment.status == PaymentStatus.confirmed),
            "confirmed_amount_kopecks": sum(int(payment.amount_kopecks) for payment in payments if payment.status == PaymentStatus.confirmed),
            "referral_bonus_kopecks": sum(referral_bonus_by_user.values()),
            "by_day": sorted(payments_by_day.values(), key=lambda item: item["date"]),
            "by_provider": list(payments_by_provider.values()),
            "by_status": list(payments_by_status.values()),
        },
    }


def get_node_by_token(db: Session, token: str | None) -> Node:
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")
    node = db.scalar(select(Node).where(Node.token == token))
    if not node:
        raise HTTPException(status_code=401, detail="Invalid token")
    return node


@app.post("/internal/nodes/register", response_model=NodeRegisterOut)
def register_node(payload: NodeRegisterIn, db: Session = Depends(get_db)) -> NodeRegisterOut:
    from app.config import get_settings
    from app.security import random_token

    settings = get_settings()
    if payload.shared_secret != settings.edge_shared_secret:
        raise HTTPException(status_code=403, detail="Invalid shared secret")

    node = db.scalar(select(Node).where(Node.name == payload.name))
    if node:
        node.hostname = payload.hostname
        node.public_ip = payload.public_ip
        node.country_code = payload.country_code
        node.city = payload.city
        node.max_clients = payload.max_clients
        node.agent_version = payload.agent_version
        node.api_url = payload.api_url
        node.status = NodeStatus.healthy
    else:
        node = Node(
            name=payload.name,
            hostname=payload.hostname,
            public_ip=payload.public_ip,
            country_code=payload.country_code,
            city=payload.city,
            max_clients=payload.max_clients,
            agent_version=payload.agent_version,
            api_url=payload.api_url,
            token=random_token(),
            status=NodeStatus.healthy,
            active_clients=0,
        )
        db.add(node)

    node.last_heartbeat_at = datetime.now(UTC)
    db.commit()
    db.refresh(node)
    return NodeRegisterOut(node_id=node.id, token=node.token)


@app.post("/internal/nodes/heartbeat")
def node_heartbeat(
    payload: HeartbeatIn,
    x_node_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_by_token(db, x_node_token)
    node.last_heartbeat_at = datetime.now(UTC)
    node.status = NodeStatus.healthy
    node.active_clients = payload.active_peers
    db.commit()
    return {"status": "ok"}


@app.post("/internal/nodes/usage")
def node_usage(
    payload: NodeUsageIn,
    x_node_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_by_token(db, x_node_token)
    update_device_usage(db, node=node, usage_rows=[x.model_dump() for x in payload.usages])
    return {"status": "ok"}


@app.post("/internal/nodes/{node_id}/peers")
def create_peer_on_node(
    node_id: int,
    payload: PeerCreateIn,
    x_node_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_by_token_for_node(db, node_id=node_id, x_node_token=x_node_token)
    device = db.get(Device, payload.device_id)
    if not device or device.node_id != node_id:
        raise HTTPException(status_code=404, detail="Device not found for node")

    queue_peer_command(
        node,
        method="POST",
        path="/peers",
        payload=payload.model_dump(),
        post_success={"type": "device_status", "device_id": device.id, "status": DeviceStatus.active.value},
    )
    return {"status": "ok"}


@app.delete("/internal/nodes/{node_id}/peers/{device_id}")
def delete_peer_on_node(
    node_id: int,
    device_id: int,
    x_node_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_by_token_for_node(db, node_id=node_id, x_node_token=x_node_token)
    device = db.get(Device, device_id)
    if not device or device.node_id != node_id:
        raise HTTPException(status_code=404, detail="Device not found for node")

    queue_peer_command(
        node,
        method="DELETE",
        path=f"/peers/{device_id}",
        post_success={"type": "device_status", "device_id": device.id, "status": DeviceStatus.deleted.value},
    )
    return {"status": "ok"}


@app.post("/internal/nodes/{node_id}/peers/{device_id}/suspend")
def suspend_peer_on_node(
    node_id: int,
    device_id: int,
    x_node_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_by_token_for_node(db, node_id=node_id, x_node_token=x_node_token)
    device = db.get(Device, device_id)
    if not device or device.node_id != node_id:
        raise HTTPException(status_code=404, detail="Device not found for node")

    queue_peer_command(
        node,
        method="POST",
        path=f"/peers/{device_id}/suspend",
        payload={"reason": "internal_api_suspend"},
        post_success={"type": "device_status", "device_id": device.id, "status": DeviceStatus.suspended.value},
    )
    return {"status": "ok"}


@app.post("/internal/nodes/{node_id}/peers/{device_id}/resume")
def resume_peer_on_node(
    node_id: int,
    device_id: int,
    x_node_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_by_token_for_node(db, node_id=node_id, x_node_token=x_node_token)
    device = db.get(Device, device_id)
    if not device or device.node_id != node_id:
        raise HTTPException(status_code=404, detail="Device not found for node")

    queue_peer_command(
        node,
        method="POST",
        path=f"/peers/{device_id}/resume",
        payload={},
        post_success={"type": "device_status", "device_id": device.id, "status": DeviceStatus.active.value},
    )
    return {"status": "ok"}


@app.post("/internal/billing/run")
def run_billing(
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> dict:
    return run_daily_billing(db)


@app.post("/internal/nodes/{node_id}/reconcile")
def reconcile_node(
    node_id: int,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> dict:
    node = db.scalar(select(Node).where(Node.id == node_id))
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return reconcile_node_peers(db, node)


@app.post("/internal/devices/{device_id}/config")
def download_config(
    device_id: int,
    _: None = Depends(require_internal_token),
    db: Session = Depends(get_db),
) -> Response:
    device = db.scalar(select(Device).where(Device.id == device_id))
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    from app.services import get_device_private_key

    conf = get_device_private_key(device)
    return Response(
        content=conf,
        media_type="text/plain",
        headers={"Content-Disposition": f"attachment; filename=device-{device.id}-amneziawg.conf"},
    )
