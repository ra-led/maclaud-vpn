# MVP VPN (AmneziaWG + Telegram)

Готовый MVP по `TASK.md` с двумя стекaми Docker Compose:
- `docker-compose.control.yml`: главная нода / control plane (`nginx`, `api`, `bot`, `worker`, `scheduler`, `postgres`, `redis`)
- `docker-compose.edge.yml`: edge-node (`awg`, `edge-agent`), которую можно выкатывать на отдельных серверах

## Что реализовано

- FastAPI control-plane API
- Redis очередь для фоновых edge-команд + worker с retry/backoff
- Telegram-бот (aiogram):
  - Инструкция
  - Баланс
  - Пополнение на 10/50/100 ₽ (реальный Telegram Payments + mock fallback)
  - Добавление устройства
  - Список устройств
  - Перевыпуск конфига
  - Удаление устройства
- Биллинг:
  - 5 ₽/день за активное устройство
  - ежедневное списание
  - `suspend` при нехватке средств
  - `resume` после пополнения
- Edge-agent:
  - авто-регистрация в control-plane
  - публикация своего `EDGE_AGENT_URL` для команд от control-plane
  - heartbeat раз в 30 сек
  - отправка usage
- Edge AWG:
  - Docker-контейнер с AmneziaWG userspace/backend
  - авто-создание `/etc/amnezia/amneziawg/awg0.conf` при первом старте
  - публикация UDP-порта `AWG_PORT`
  - общий volume с edge-agent для server config, QR и client `.conf`
- PostgreSQL модели + Alembic migration
- Nginx reverse proxy
- Log rotation в обоих compose

## Структура

- `control_plane/app/main.py` — API control plane
- `control_plane/app/bot.py` — Telegram-бот
- `control_plane/app/scheduler.py` — периодические задачи
- `control_plane/app/services.py` — бизнес-логика (billing/devices/nodes)
- `edge_agent/app/main.py` — edge-agent
- `nginx/nginx.conf` — reverse proxy

## Быстрый запуск

1. Скопировать env:

```bash
cd /Users/yuratomakov/vpn/vpn-mvp
cp .env.control.example .env.control
cp .env.edge.example .env.edge
```

2. Обязательные переменные в `.env.control`:
- `TELEGRAM_BOT_TOKEN`
- `FERNET_KEY` (можно сгенерировать: `python3 -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())"`)
- `EDGE_SHARED_SECRET` (должен совпадать в `.env.edge`)
- `INTERNAL_API_TOKEN` (для bot/internal endpoints)
- `ADMIN_API_TOKEN` (для admin endpoints)
- `ALLOW_MOCK_PAYMENTS=false` для production

3. Запустить control-plane:

```bash
docker compose -f docker-compose.control.yml up --build -d
```

4. Запустить edge-node:

```bash
docker compose -f docker-compose.edge.yml up --build -d
```

## Edge-ноды на отдельных серверах

Идея деплоя такая:

1. На главной ноде запущен `docker-compose.control.yml`; она хранит БД и пул VPN-серверов.
2. На любом edge-сервере копируется `docker-compose.edge.yml`, `edge_awg/`, `edge_agent/` и `.env.edge`.
3. В `.env.edge` задаются:
   - `CONTROL_PLANE_URL` — публичный или приватный URL главной ноды, доступный с edge-сервера.
   - `EDGE_PUBLIC_IP` — публичный IP edge-сервера.
   - `EDGE_AGENT_URL` — URL edge-agent, доступный с главной ноды. Можно оставить `auto`, тогда будет опубликовано `http://EDGE_PUBLIC_IP:EDGE_AGENT_PORT`.
   - `EDGE_SHARED_SECRET` — общий секрет регистрации, совпадает с control-plane.
   - `AWG_PORT` — UDP-порт AmneziaWG, по умолчанию `51820`.
   - `AWG_NET` — клиентская IPv4-сеть без последнего октета, по умолчанию `10.77.0`.
4. После старта edge-agent сам регистрируется в control-plane через `/internal/nodes/register`.
5. Control-plane видит ноду как healthy после heartbeat и начинает выбирать ее для новых устройств.

Для production лучше закрыть порт `8081` firewall'ом так, чтобы к edge-agent могла ходить только главная нода. UDP-порт `AWG_PORT` должен быть доступен клиентам.

## Миграции Alembic

Контейнер `api` перед стартом автоматически выполняет `alembic upgrade head`.
Вручную миграции можно применить так:

```bash
docker compose -f docker-compose.control.yml exec api alembic upgrade head
```

Для production ожидается `AUTO_CREATE_SCHEMA=false`; схема должна управляться миграциями.

## Основные API

### External
- `GET /health`
- `POST /v1/users`
- `GET /v1/users/{telegram_id}/profile`
- `GET /v1/users/{telegram_id}/balance`
- `POST /v1/payments/mock/confirm`
- `POST /v1/payments/external/confirm`
- `GET /v1/users/{telegram_id}/devices`
- `POST /v1/devices`
- `POST /v1/devices/{device_id}/regenerate?telegram_id=...`
- `PATCH /v1/devices/{device_id}?telegram_id=...`
- `DELETE /v1/devices/{device_id}?telegram_id=...`
- `POST /v1/admin/users/{telegram_id}/ban`
- `POST /v1/admin/devices/{device_id}/ban`
- `GET /v1/nodes`

### Internal (edge -> control)
- `POST /internal/nodes/register`
- `POST /internal/nodes/heartbeat`
- `POST /internal/nodes/usage`
- `POST /internal/nodes/{node_id}/peers`
- `DELETE /internal/nodes/{node_id}/peers/{device_id}`
- `POST /internal/nodes/{node_id}/peers/{device_id}/suspend`
- `POST /internal/nodes/{node_id}/peers/{device_id}/resume`

## Важно для MVP

- Edge-agent применяет lifecycle AWG peers через `awg set`, хранит локальное состояние и читает usage через `awg show`.
- Control-plane создает устройства по биллингу, вызывает edge-agent `POST /peers`, получает `.conf` и QR, сохраняет `.conf` зашифрованным и отдает его пользователю.
- Для production нужно использовать HTTPS или приватную сеть между edge/control и ограничить доступ к edge-agent.
