"""device unique keys only for non-deleted devices

Revision ID: 0003_device_live_unique
Revises: 0002_idempotent_daily_billing
Create Date: 2026-06-11 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0003_device_live_unique"
down_revision = "0002_idempotent_daily_billing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("devices_vpn_ip_key", "devices", type_="unique")
    op.drop_constraint("devices_public_key_key", "devices", type_="unique")
    op.create_index(
        "uq_devices_vpn_ip_not_deleted",
        "devices",
        ["vpn_ip"],
        unique=True,
        postgresql_where=sa.text("status <> 'deleted'"),
    )
    op.create_index(
        "uq_devices_public_key_not_deleted",
        "devices",
        ["public_key"],
        unique=True,
        postgresql_where=sa.text("status <> 'deleted'"),
    )


def downgrade() -> None:
    op.drop_index("uq_devices_public_key_not_deleted", table_name="devices")
    op.drop_index("uq_devices_vpn_ip_not_deleted", table_name="devices")
    op.create_unique_constraint("devices_public_key_key", "devices", ["public_key"])
    op.create_unique_constraint("devices_vpn_ip_key", "devices", ["vpn_ip"])
