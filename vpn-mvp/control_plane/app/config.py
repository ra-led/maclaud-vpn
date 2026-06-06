from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env.control', env_file_encoding='utf-8', extra='ignore')

    database_url: str = 'postgresql+psycopg://vpn:vpn@postgres:5432/vpn'
    api_host: str = '0.0.0.0'
    api_port: int = 8000

    telegram_bot_token: str = ''
    telegram_provider_token: str = ''
    api_base_url: str = 'http://api:8000'
    redis_url: str = 'redis://redis:6379/0'
    internal_api_token: str = ''
    admin_api_token: str = ''
    auto_create_schema: bool = False
    allow_mock_payments: bool = False

    edge_shared_secret: str = 'dev-secret'

    fernet_key: str = ''
    node_heartbeat_timeout_sec: int = 120
    daily_device_price_kopecks: int = 200


@lru_cache
def get_settings() -> Settings:
    return Settings()
