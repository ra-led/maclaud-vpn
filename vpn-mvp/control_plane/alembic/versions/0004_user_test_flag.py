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
    op.add_column("users", sa.Column("test", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("users", "test")
