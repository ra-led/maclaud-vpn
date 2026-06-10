import logging
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.blocking import BlockingScheduler
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import AuditLog, Device, DeviceStatus, DeviceUsageDaily, Node, NodeStatus, User
from app.services import mark_offline_nodes, reconcile_node_peers, resume_user_devices_if_possible, run_daily_billing

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def daily_billing_job() -> None:
    with SessionLocal() as db:
        result = run_daily_billing(db)
        logging.info("daily billing: %s", result)


def health_and_resume_job() -> None:
    with SessionLocal() as db:
        nodes_updated = mark_offline_nodes(db)
        logging.info("node health update done, changed=%s", nodes_updated)

        users = db.scalars(select(User)).all()
        resumed = 0
        for user in users:
            has_suspended = db.scalar(
                select(func.count(Device.id)).where(
                    Device.user_id == user.id,
                    Device.status == DeviceStatus.suspended,
                )
            )
            if has_suspended:
                resume_user_devices_if_possible(db, user)
                resumed += 1
        logging.info("resume check done, users_checked=%s", resumed)


def reconcile_nodes_job() -> None:
    with SessionLocal() as db:
        nodes = db.scalars(select(Node).where(Node.status == NodeStatus.healthy)).all()
        reconciled = 0
        failed = 0
        for node in nodes:
            try:
                result = reconcile_node_peers(db, node)
                reconciled += 1
                logging.info("node reconcile done: %s", result)
            except Exception as exc:  # noqa: BLE001
                failed += 1
                logging.exception("node reconcile failed node_id=%s", node.id)
                db.rollback()
                db.add(
                    AuditLog(
                        actor_type="scheduler",
                        actor_id="reconcile",
                        entity_type="node",
                        entity_id=str(node.id),
                        action="node_reconcile_failed",
                        payload_json={"error": str(exc)},
                    )
                )
                db.commit()
        logging.info("node reconcile cycle done, reconciled=%s failed=%s", reconciled, failed)


def usage_sync_job() -> None:
    # Keep usage table consistent every few minutes:
    # for every non-deleted device ensure there is a row for today.
    with SessionLocal() as db:
        today = date.today()
        devices = db.scalars(select(Device).where(Device.status != DeviceStatus.deleted)).all()
        created_rows = 0
        for device in devices:
            existing = db.scalar(
                select(DeviceUsageDaily).where(
                    DeviceUsageDaily.device_id == device.id,
                    DeviceUsageDaily.date == today,
                )
            )
            if not existing:
                db.add(DeviceUsageDaily(device_id=device.id, date=today, rx_bytes=0, tx_bytes=0))
                created_rows += 1
        if created_rows:
            db.commit()
        logging.info("usage sync done, initialized_rows=%s", created_rows)


def hourly_usage_aggregation_job() -> None:
    # Aggregate usage per node and per user and store immutable snapshots.
    with SessionLocal() as db:
        today = date.today()
        rows = db.scalars(select(DeviceUsageDaily).where(DeviceUsageDaily.date == today)).all()

        by_node: dict[int, dict[str, int]] = {}
        by_user: dict[int, dict[str, int]] = {}
        for row in rows:
            device = db.get(Device, row.device_id)
            if not device:
                continue
            node_bucket = by_node.setdefault(device.node_id, {"rx_bytes": 0, "tx_bytes": 0, "devices": 0})
            node_bucket["rx_bytes"] += int(row.rx_bytes)
            node_bucket["tx_bytes"] += int(row.tx_bytes)
            node_bucket["devices"] += 1

            user_bucket = by_user.setdefault(device.user_id, {"rx_bytes": 0, "tx_bytes": 0, "devices": 0})
            user_bucket["rx_bytes"] += int(row.rx_bytes)
            user_bucket["tx_bytes"] += int(row.tx_bytes)
            user_bucket["devices"] += 1

        db.add(
            AuditLog(
                actor_type="scheduler",
                actor_id="hourly",
                entity_type="usage",
                entity_id=today.isoformat(),
                action="hourly_usage_aggregate",
                payload_json={"by_node": by_node, "by_user": by_user},
            )
        )
        db.commit()
        logging.info(
            "hourly usage aggregation done, nodes=%s users=%s",
            len(by_node),
            len(by_user),
        )


def cleanup_job() -> None:
    # Remove stale temporary artifacts: old QR/conf/temp files.
    now = datetime.now(UTC)
    ttl = timedelta(hours=24)
    candidates = [
        Path("/tmp"),
        Path("/var/tmp"),
        Path("/app/tmp"),
    ]
    removed = 0

    for root in candidates:
        if not root.exists() or not root.is_dir():
            continue
        for path in root.glob("vpn-*"):
            if not path.is_file():
                continue
            try:
                mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
                if now - mtime >= ttl:
                    path.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                continue
    logging.info("cleanup job executed, removed_files=%s", removed)


def main() -> None:
    scheduler = BlockingScheduler(timezone="UTC")

    # Daily tasks
    scheduler.add_job(daily_billing_job, "cron", hour=0, minute=5, id="daily_billing")

    # Every 1-5 minutes
    scheduler.add_job(health_and_resume_job, "interval", minutes=2, id="health_resume")
    scheduler.add_job(reconcile_nodes_job, "interval", minutes=10, id="node_reconcile")
    scheduler.add_job(usage_sync_job, "interval", minutes=5, id="usage_sync")
    scheduler.add_job(cleanup_job, "interval", minutes=5, id="cleanup")

    # Every hour
    scheduler.add_job(hourly_usage_aggregation_job, "cron", minute=0, id="hourly_usage_aggregation")

    logging.info("scheduler started at %s", datetime.now(UTC))
    scheduler.start()


if __name__ == "__main__":
    main()
