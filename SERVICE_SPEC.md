# Paid VPN Service Specification

## Purpose

This repository implements a paid AmneziaWG VPN service. The product consists of:

- A public landing website with pricing, a customer dashboard UI, and YooKassa payments.
- A central control plane hosted on the main node. It owns users, balances, payments, devices, node registry, billing, and operational state.
- One or more internet-distributed edge nodes that run AmneziaWG in Docker and expose a small authenticated agent API for peer lifecycle commands.
- A Telegram bot interface for MVP operations. Telegram payments are not part of the production payment flow.

## High-Level Architecture

The control plane is the source of truth. It stores users, account balances, device records, node records, payment records, usage counters, billing events, and audit logs in PostgreSQL.

Edge nodes can be deployed on arbitrary servers. Each edge node runs an `awg` container and an `edge-agent` container in the same network namespace. On startup, the edge-agent connects to the central control plane, registers its public API URL, receives a node token, sends heartbeats and usage deltas, and applies peer commands through `awg set`.

The website handles YooKassa checkout. After YooKassa confirms a successful payment, the website verifies the payment through the YooKassa API, persists the payment event locally, and calls the control plane internal payment endpoint to top up the matching account balance.

## Components

### Website

Location: `vpn-website`

Responsibilities:

- Render the public VPN landing and customer dashboard UI.
- Create YooKassa redirect payments through `POST /api/create-payment`.
- Receive YooKassa webhooks at `POST /api/yookassa-webhook`.
- Verify YooKassa webhook payment IDs through YooKassa API before accepting payment state.
- Persist YooKassa payment records and webhook events in the website PostgreSQL database.
- Synchronize successful YooKassa payments into the control plane through `POST /v1/payments/external/confirm`.

Important environment variables:

- `YOOKASSA_SHOP_ID`
- `YOOKASSA_SECRET_KEY`
- `BASE_URL`
- `DATABASE_URL`
- `CONTROL_PLANE_API_URL`
- `CONTROL_PLANE_INTERNAL_TOKEN`
- `CONTROL_PLANE_SYNC_ENABLED`

### Control Plane

Location: `vpn-mvp/control_plane`

Responsibilities:

- Store account, billing, device, node, and usage state.
- Accept internal payment confirmations from the website.
- Ask selected edge nodes to generate AmneziaWG client configs and QR codes.
- Select a healthy node for new devices.
- Apply peer commands to edge nodes.
- Run daily billing and suspend devices when balance is insufficient.
- Resume suspended devices after a successful top-up when possible.
- Accept edge node registration, heartbeat, and usage reports.

Primary services:

- `api`: FastAPI HTTP API.
- `worker`: Redis-backed retry worker for asynchronous edge commands.
- `scheduler`: periodic billing, health, resume, usage, and cleanup jobs.
- `bot`: Telegram MVP interface.
- `postgres`: control-plane database.
- `redis`: edge command queue.
- `nginx`: public reverse proxy.

### Edge Node

Location: `vpn-mvp/edge_agent` and `vpn-mvp/edge_awg`

Responsibilities:

- Register the node with the control plane using `EDGE_SHARED_SECRET`.
- Publish the edge-agent URL that the control plane can call for peer commands.
- Persist the issued node token locally.
- Wait for the AmneziaWG interface to become available.
- Restore active peers from local state after restart.
- Apply peer create, delete, suspend, and resume commands.
- Send heartbeat and usage deltas to the control plane.

The edge-agent API is authenticated with `X-Edge-Token`; heartbeat and usage calls to the control plane use `X-Node-Token`.

## Payment Flow

1. The website creates or reuses a browser-local numeric account id and sends it as `user_id` when creating a YooKassa payment.
2. `POST /api/create-payment` creates a YooKassa payment with metadata:
   - `user_id`
   - `order_id`
   - `plan_name`
3. The user is redirected to YooKassa.
4. YooKassa sends a webhook to `POST /api/yookassa-webhook`.
5. The website verifies the payment by fetching it from YooKassa API.
6. The website saves the YooKassa payment state locally.
7. If the verified status is `succeeded`, the website calls the control plane:
   - `POST /v1/payments/external/confirm`
   - Header: `X-Internal-Token`
   - Body: numeric account id, amount in kopecks, YooKassa payment id, provider `yookassa`
8. The control plane idempotently records the payment and increments the user's balance.
9. If the user has suspended devices and the new balance is positive, resume commands are queued.

The control-plane payment confirmation is idempotent by `external_payment_id`, so repeated YooKassa webhooks or status checks do not double-credit the balance.

## Device Provisioning Flow

1. A user requests a new device.
2. The control plane checks that the user is not banned and has a positive balance.
3. The control plane selects the healthiest node with available capacity.
4. The control plane creates a device row and asks the edge-agent to create an AmneziaWG peer.
5. The control plane creates the device in the current DB transaction and flushes it to obtain a device id.
6. The control plane calls the selected edge-agent `POST /peers`.
7. If the edge command fails, the DB transaction is rolled back and no active device is stored.
8. If the edge command succeeds, the device is committed as active and the AmneziaWG `.conf` plus QR code are returned to the user.

Regenerating a config applies the new peer on the edge before committing the new key to the database. Deleting a device removes the peer from the edge before marking the device deleted.

## Billing Flow

1. The scheduler runs daily billing at 00:05 UTC.
2. The control plane counts each user's active devices.
3. Each active device costs `DAILY_DEVICE_PRICE_KOPECKS` per day.
4. If the user has enough balance, the daily charge is deducted and a billing event is stored.
5. If the balance is insufficient, suspend commands are queued for active devices.
6. Worker retries edge commands with backoff and applies device status changes only after successful edge execution.

## Networking Model

The control plane is the main node. It runs the central database and the node registry. Edge stacks are intended to run on separate internet servers. A new VPN server is added by copying the edge compose bundle to a server, setting its `.env.edge`, and starting it. The edge-agent then registers itself with the control plane and becomes eligible for device placement.

Required connectivity:

- Edge -> Control Plane: the edge-agent must reach `CONTROL_PLANE_URL`.
- Control Plane -> Edge: the control-plane `api` and `worker` must reach the registered `EDGE_AGENT_URL`.
- VPN Clients -> Edge: clients must reach the edge server's AmneziaWG UDP port.

Edge registration payload includes:

- node name
- hostname
- public IP
- country and city
- maximum client capacity
- agent version
- edge-agent API URL

For local single-host Docker deployments:

- Control-plane API is published on host port `8000`.
- Edge-agent is published through the AWG service network namespace on host port `8081`.
- `CONTROL_PLANE_URL=http://host.docker.internal:8000`
- `EDGE_AGENT_URL=http://host.docker.internal:8081`
- Compose files add `host.docker.internal:host-gateway` for Linux Docker compatibility.

For production:

- `CONTROL_PLANE_URL` should point to the central control-plane URL reachable from every edge node, for example `https://control.example.com`.
- `EDGE_AGENT_URL=auto` publishes `http://EDGE_PUBLIC_IP:EDGE_AGENT_PORT`; set an explicit HTTPS URL if the edge-agent is behind a reverse proxy or private overlay network.
- `EDGE_PUBLIC_IP` must be the address clients use in AmneziaWG endpoints and, when `EDGE_AGENT_URL=auto`, the address the control plane uses for agent commands.
- The edge-agent port should be firewall-restricted to the central control-plane IP whenever possible.
- Internal tokens and node tokens must be treated as production secrets.

## Deployment Notes

- The control-plane API container runs `alembic upgrade head` before starting FastAPI.
- `AUTO_CREATE_SCHEMA=false` is the expected production setting; migrations own schema changes.
- Website startup requires `CONTROL_PLANE_INTERNAL_TOKEN` while control-plane sync is enabled.
- YooKassa webhook IP filtering is enabled by default in production.
- Telegram payments are not part of the production payment flow.

## Production Readiness Checklist

- Set all secrets in environment files or a secret manager.
- Use real HTTPS URLs for website, control-plane, and edge-agent private connectivity.
- Run the control-plane, website, and edge databases with backups.
- Restrict edge-agent access by firewall, private network, or mTLS.
- Verify YooKassa webhook delivery and payment status polling in a staging shop.
- Add automated tests for payment idempotency, device provisioning rollback, billing suspension, and resume flows.
- Monitor API, worker, scheduler, edge-agent, Redis queue length, node heartbeat age, and payment sync failures.
