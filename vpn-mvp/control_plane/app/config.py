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
    app_env: str = 'development'

    edge_shared_secret: str = 'dev-secret'

    fernet_key: str = ''
    node_heartbeat_timeout_sec: int = 120
    daily_device_price_kopecks: int = 500

    def validate_for_runtime(self) -> None:
        if self.app_env.lower() != 'production':
            return
        placeholders = {'', 'replace_me', 'replace_me_shared_secret', 'replace_me_fernet_key', 'replace_me_internal_token', 'replace_me_admin_token', 'dev-secret'}
        required = {
            'FERNET_KEY': self.fernet_key,
            'EDGE_SHARED_SECRET': self.edge_shared_secret,
            'INTERNAL_API_TOKEN': self.internal_api_token,
            'ADMIN_API_TOKEN': self.admin_api_token,
        }
        bad = [name for name, value in required.items() if value in placeholders or len(str(value)) < 24]
        if bad:
            raise RuntimeError(f'Unsafe production control-plane secrets: {", ".join(bad)}')


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.validate_for_runtime()
    return settings
