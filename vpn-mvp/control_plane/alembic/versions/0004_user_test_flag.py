"""add user test flag

Revision ID: 0004_user_test_flag
Revises: 0003_device_live_unique
Create Date: 2026-06-11 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0004_user_test_flag"
down_revision = "0003_device_live_unique"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS test BOOLEAN NOT NULL DEFAULT false")


def downgrade() -> None:
    op.drop_column("users", "test")
