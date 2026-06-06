from datetime import datetime

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str


class UserProfileOut(BaseModel):
    id: int
    telegram_id: int
    username: str | None
    first_name: str | None
    status: str
    balance_kopecks: int


class BalanceOut(BaseModel):
    balance_kopecks: int
    active_devices: int
    daily_charge_kopecks: int
    days_left: int | None


class CreateOrGetUserIn(BaseModel):
    telegram_id: int
    username: str | None = None
    first_name: str | None = None


class DeviceCreateIn(BaseModel):
    telegram_id: int
    name: str = Field(min_length=1, max_length=255)


class DeviceRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class DeviceOut(BaseModel):
    id: int
    name: str
    status: str
    node_name: str
    country_code: str
    city: str | None
    vpn_ip: str
    created_at: datetime
    rx_bytes: int
    tx_bytes: int


class DeviceCreateOut(BaseModel):
    device_id: int
    node_id: int
    conf_text: str
    conf_filename: str
    qr_png_base64: str


class PaymentCreateIn(BaseModel):
    telegram_id: int
    amount_rub: int
    external_payment_id: str | None = None


class ExternalPaymentConfirmIn(BaseModel):
    telegram_id: int
    amount_kopecks: int = Field(gt=0)
    external_payment_id: str
    provider: str = Field(default='yookassa', min_length=1, max_length=100)


class PaymentOut(BaseModel):
    id: int
    amount_kopecks: int
    currency: str
    status: str


class NodeRegisterIn(BaseModel):
    shared_secret: str
    name: str
    hostname: str
    public_ip: str
    country_code: str
    city: str | None = None
    max_clients: int = 300
    agent_version: str = '0.1.0'
    api_url: str


class NodeRegisterOut(BaseModel):
    node_id: int
    token: str


class HeartbeatIn(BaseModel):
    active_peers: int
    tx_bytes: int = 0
    rx_bytes: int = 0
    cpu_load: float = 0.0
    disk_free_bytes: int = 0


class NodeUsageItem(BaseModel):
    device_id: int
    rx_bytes: int = 0
    tx_bytes: int = 0


class NodeUsageIn(BaseModel):
    usages: list[NodeUsageItem]


class PeerCreateIn(BaseModel):
    device_id: int
    name: str = ""


class AdminBanIn(BaseModel):
    reason: str = 'manual admin ban'
