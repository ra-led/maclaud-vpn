import enum
from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, Enum, ForeignKey, Index, Integer, JSON, String, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class UserStatus(str, enum.Enum):
    active = 'active'
    banned = 'banned'


class PaymentStatus(str, enum.Enum):
    pending = 'pending'
    confirmed = 'confirmed'
    failed = 'failed'


class NodeStatus(str, enum.Enum):
    healthy = 'healthy'
    unhealthy = 'unhealthy'
    offline = 'offline'


class DeviceStatus(str, enum.Enum):
    active = 'active'
    suspended = 'suspended'
    banned = 'banned'
    deleted = 'deleted'


class User(Base):
    __tablename__ = 'users'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[UserStatus] = mapped_column(Enum(UserStatus), default=UserStatus.active)
    balance_kopecks: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    devices: Mapped[list['Device']] = relationship(back_populates='user')
    payments: Mapped[list['Payment']] = relationship(back_populates='user')


class Payment(Base):
    __tablename__ = 'payments'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    provider: Mapped[str] = mapped_column(String(100), default='telegram')
    external_payment_id: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    amount_kopecks: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(8), default='RUB')
    status: Mapped[PaymentStatus] = mapped_column(Enum(PaymentStatus), default=PaymentStatus.pending)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates='payments')


class Node(Base):
    __tablename__ = 'nodes'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    hostname: Mapped[str] = mapped_column(String(255))
    public_ip: Mapped[str] = mapped_column(String(64))
    country_code: Mapped[str] = mapped_column(String(8), default='UN')
    city: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[NodeStatus] = mapped_column(Enum(NodeStatus), default=NodeStatus.healthy)
    max_clients: Mapped[int] = mapped_column(Integer, default=300)
    active_clients: Mapped[int] = mapped_column(Integer, default=0)
    api_url: Mapped[str] = mapped_column(String(255), default='http://edge-agent:8081')
    token: Mapped[str] = mapped_column(String(255), unique=True)
    agent_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    devices: Mapped[list['Device']] = relationship(back_populates='node')


class Device(Base):
    __tablename__ = 'devices'
    __table_args__ = (
        Index('uq_devices_vpn_ip_not_deleted', 'vpn_ip', unique=True, postgresql_where=text("status <> 'deleted'")),
        Index('uq_devices_public_key_not_deleted', 'public_key', unique=True, postgresql_where=text("status <> 'deleted'")),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    node_id: Mapped[int] = mapped_column(ForeignKey('nodes.id'), index=True)
    name: Mapped[str] = mapped_column(String(255))
    vpn_ip: Mapped[str] = mapped_column(String(64))
    public_key: Mapped[str] = mapped_column(String(255))
    private_key_encrypted: Mapped[str] = mapped_column(String(1024))
    status: Mapped[DeviceStatus] = mapped_column(Enum(DeviceStatus), default=DeviceStatus.active)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates='devices')
    node: Mapped[Node] = relationship(back_populates='devices')


class DeviceUsageDaily(Base):
    __tablename__ = 'device_usage_daily'
    __table_args__ = (UniqueConstraint('device_id', 'date', name='uq_device_usage_daily'),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey('devices.id'), index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    rx_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    tx_bytes: Mapped[int] = mapped_column(BigInteger, default=0)


class BillingEvent(Base):
    __tablename__ = 'billing_events'
    __table_args__ = (UniqueConstraint('user_id', 'event_type', 'billing_date', name='uq_billing_event_user_type_date'),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    amount_kopecks: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(64))
    description: Mapped[str] = mapped_column(String(500))
    billing_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuditLog(Base):
    __tablename__ = 'audit_log'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    actor_type: Mapped[str] = mapped_column(String(64))
    actor_id: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(128))
    payload_json: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
