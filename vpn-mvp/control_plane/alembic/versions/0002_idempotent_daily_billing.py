"""idempotent daily billing

Revision ID: 0002_idempotent_daily_billing
Revises: 0001_init
Create Date: 2026-06-10 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0002_idempotent_daily_billing"
down_revision = "0001_init"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("billing_events", sa.Column("billing_date", sa.Date(), nullable=True))
    op.create_unique_constraint(
        "uq_billing_event_user_type_date",
        "billing_events",
        ["user_id", "event_type", "billing_date"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_billing_event_user_type_date", "billing_events", type_="unique")
    op.drop_column("billing_events", "billing_date")
