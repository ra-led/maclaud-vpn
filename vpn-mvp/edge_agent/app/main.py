import asyncio
import base64
import logging
import re
import subprocess
from pathlib import Path

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings
from app.state import AgentState, PeerState, load_state, save_state

settings = get_settings()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="VPN Edge Agent MVP", version="0.1.0")
STATE_FILE = Path("/var/lib/edge-agent/state.json")
state: AgentState = load_state(STATE_FILE)


class PeerCreateIn(BaseModel):
    device_id: int
    name: str = Field(default="", max_length=255)


def ensure_internal_auth(x_edge_token: str | None) -> None:
    if not state.token:
        raise HTTPException(status_code=503, detail="Node token not ready")
    if x_edge_token != state.token:
        raise HTTPException(status_code=401, detail="Invalid token")


def persist() -> None:
    save_state(STATE_FILE, state)


def run_cmd(cmd: list[str], timeout: int = 30) -> str:
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout)
        return result.stdout.strip()
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=f"Command failed: {' '.join(cmd)} :: {exc.stderr.strip()}") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"Command timed out: {' '.join(cmd)}") from exc


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-")
    return slug or "device"


def client_name(device_id: int, raw_name: str) -> str:
    return f"{slugify(raw_name)}-{device_id}"


def conf_path(name: str) -> Path:
    return Path(settings.awg_client_config_dir) / f"{name}.conf"


def qr_path(name: str) -> Path:
    return Path(settings.awg_qr_dir) / f"{name}.png"


def parse_generator_output(output: str) -> tuple[str, str | None, str | None]:
    vpn_ip = ""
    conf = None
    qr = None
    for line in output.splitlines():
        if line.startswith("IP:"):
            vpn_ip = line.split(":", 1)[1].strip().removesuffix("/32")
        elif line.startswith("Config:"):
            conf = line.split(":", 1)[1].strip()
        elif line.startswith("QR:"):
            qr = line.split(":", 1)[1].strip()
    return vpn_ip, conf, qr


def read_peer_block(name: str) -> dict[str, str]:
    server_conf = Path(settings.awg_server_conf)
    if not server_conf.exists():
        raise HTTPException(status_code=500, detail=f"AWG server config not found: {server_conf}")

    lines = server_conf.read_text(encoding="utf-8").splitlines()
    for idx, line in enumerate(lines):
        if line.strip() != f"# {name}":
            continue
        block = {}
        for block_line in lines[idx + 1 :]:
            stripped = block_line.strip()
            if stripped.startswith("# ") or stripped == "[Peer]":
                if stripped.startswith("# "):
                    break
                continue
            if not stripped:
                continue
            if "=" in stripped:
                key, value = stripped.split("=", 1)
                block[key.strip()] = value.strip()
        if "PublicKey" not in block or "AllowedIPs" not in block:
            raise HTTPException(status_code=500, detail=f"Incomplete AWG peer block for {name}")
        return block
    raise HTTPException(status_code=500, detail=f"AWG peer block not found for {name}")


def remove_peer_block(name: str) -> None:
    server_conf = Path(settings.awg_server_conf)
    if not server_conf.exists():
        return

    lines = server_conf.read_text(encoding="utf-8").splitlines()
    next_lines = []
    idx = 0
    while idx < len(lines):
        if lines[idx].strip() == f"# {name}":
            idx += 1
            while idx < len(lines) and not lines[idx].strip().startswith("# "):
                idx += 1
            continue
        next_lines.append(lines[idx])
        idx += 1
    server_conf.write_text("\n".join(next_lines).rstrip() + "\n", encoding="utf-8")


def awg_remove_peer(public_key: str) -> None:
    if public_key:
        subprocess.run(["awg", "set", settings.awg_interface, "peer", public_key, "remove"], capture_output=True, text=True)


def awg_apply_peer(peer: PeerState) -> None:
    block = read_peer_block(peer.name)
    psk = block.get("PresharedKey", "")
    allowed_ips = block["AllowedIPs"]
    cmd = ["awg", "set", settings.awg_interface, "peer", peer.public_key, "allowed-ips", allowed_ips]
    if psk:
        psk_path = Path("/tmp") / f"awg-psk-{peer.device_id}"
        psk_path.write_text(psk, encoding="utf-8")
        try:
            cmd = ["awg", "set", settings.awg_interface, "peer", peer.public_key, "preshared-key", str(psk_path), "allowed-ips", allowed_ips]
            run_cmd(cmd)
        finally:
            psk_path.unlink(missing_ok=True)
    else:
        run_cmd(cmd)


def create_awg_peer(device_id: int, raw_name: str) -> tuple[PeerState, str, str]:
    name = client_name(device_id, raw_name)
    existing = state.peers.get(device_id)
    if existing:
        delete_awg_peer(existing)

    output = run_cmd([settings.awg_generator_cmd, name], timeout=60)
    vpn_ip, generated_conf, generated_qr = parse_generator_output(output)
    cfg_path = Path(generated_conf) if generated_conf else conf_path(name)
    png_path = Path(generated_qr) if generated_qr else qr_path(name)
    if not cfg_path.exists() or not png_path.exists():
        raise HTTPException(status_code=500, detail=f"AWG generator did not create expected files for {name}")

    block = read_peer_block(name)
    vpn_ip = vpn_ip or block["AllowedIPs"].removesuffix("/32")
    peer = PeerState(
        device_id=device_id,
        name=name,
        public_key=block["PublicKey"],
        vpn_ip=vpn_ip,
        conf_path=str(cfg_path),
        qr_path=str(png_path),
        status="active",
    )
    return peer, cfg_path.read_text(encoding="utf-8"), base64.b64encode(png_path.read_bytes()).decode()


def delete_awg_peer(peer: PeerState) -> None:
    awg_remove_peer(peer.public_key)
    remove_peer_block(peer.name)
    if peer.conf_path:
        Path(peer.conf_path).unlink(missing_ok=True)
    if peer.qr_path:
        Path(peer.qr_path).unlink(missing_ok=True)


def parse_transfer() -> dict[str, tuple[int, int]]:
    output = run_cmd(["awg", "show", settings.awg_interface, "transfer"])
    if not output:
        return {}
    result = {}
    for line in output.splitlines():
        parts = line.split()
        if len(parts) == 3:
            public_key, rx, tx = parts
            result[public_key] = (int(rx), int(tx))
    return result


async def wait_awg_interface(timeout_sec: int = 30) -> None:
    for _ in range(timeout_sec):
        probe = subprocess.run(["awg", "show", settings.awg_interface], capture_output=True, text=True)
        if probe.returncode == 0:
            return
        await asyncio.sleep(1)
    raise RuntimeError(f"AmneziaWG interface {settings.awg_interface} is not ready")


def restore_active_peers() -> None:
    for peer in state.peers.values():
        if peer.status != "active":
            continue
        try:
            awg_apply_peer(peer)
        except HTTPException:
            logging.exception("failed to restore active peer device_id=%s", peer.device_id)


async def register_node() -> None:
    payload = {
        "shared_secret": settings.edge_shared_secret,
        "name": settings.edge_node_name,
        "hostname": settings.edge_hostname,
        "public_ip": settings.edge_public_ip,
        "country_code": settings.edge_country_code,
        "city": settings.edge_city,
        "max_clients": settings.edge_max_clients,
        "agent_version": settings.edge_agent_version,
        "api_url": settings.resolved_edge_agent_url,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(f"{settings.resolved_control_plane_url}/internal/nodes/register", json=payload)
        response.raise_for_status()
        data = response.json()
        state.node_id = data["node_id"]
        state.token = data["token"]
    persist()
    logging.info("registered node id=%s", state.node_id)


async def heartbeat_loop() -> None:
    last_transfer: dict[str, tuple[int, int]] = {}
    while True:
        if not state.token:
            await asyncio.sleep(3)
            continue

        transfer = parse_transfer()
        usage_rows = []
        for peer in state.peers.values():
            if peer.status != "active":
                continue
            current_rx, current_tx = transfer.get(peer.public_key, (0, 0))
            prev_rx, prev_tx = last_transfer.get(peer.public_key, (0, 0))
            delta_rx = max(0, current_rx - prev_rx)
            delta_tx = max(0, current_tx - prev_tx)
            if delta_rx > 0 or delta_tx > 0:
                usage_rows.append({"device_id": peer.device_id, "rx_bytes": delta_rx, "tx_bytes": delta_tx})
        last_transfer = transfer

        payload = {
            "active_peers": len([p for p in state.peers.values() if p.status == "active"]),
            "tx_bytes": sum(v[1] for v in transfer.values()),
            "rx_bytes": sum(v[0] for v in transfer.values()),
            "cpu_load": 0.1,
            "disk_free_bytes": 10_000_000_000,
        }
        headers = {"X-Node-Token": state.token}
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(f"{settings.resolved_control_plane_url}/internal/nodes/heartbeat", json=payload, headers=headers)
                if usage_rows:
                    await client.post(
                        f"{settings.resolved_control_plane_url}/internal/nodes/usage",
                        json={"usages": usage_rows},
                        headers=headers,
                    )
        except httpx.HTTPError:
            logging.exception("heartbeat failed")
        await asyncio.sleep(30)


@app.on_event("startup")
async def startup_event() -> None:
    await wait_awg_interface()
    restore_active_peers()
    await register_node()
    asyncio.create_task(heartbeat_loop())


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "node_id": state.node_id, "peers": len(state.peers)}


@app.get("/peers")
def list_peers(x_edge_token: str | None = Header(default=None)) -> dict:
    ensure_internal_auth(x_edge_token)
    return {
        "peers": [
            {
                "device_id": peer.device_id,
                "name": peer.name,
                "public_key": peer.public_key,
                "vpn_ip": peer.vpn_ip,
                "status": peer.status,
            }
            for peer in state.peers.values()
        ]
    }


@app.post("/peers")
def create_peer(payload: PeerCreateIn, x_edge_token: str | None = Header(default=None)) -> dict:
    ensure_internal_auth(x_edge_token)
    peer, conf_text, qr_png_base64 = create_awg_peer(payload.device_id, payload.name)
    state.peers[payload.device_id] = peer
    persist()
    return {
        "status": "ok",
        "public_key": peer.public_key,
        "vpn_ip": peer.vpn_ip,
        "conf_text": conf_text,
        "qr_png_base64": qr_png_base64,
    }


@app.delete("/peers/{device_id}")
def delete_peer(device_id: int, x_edge_token: str | None = Header(default=None)) -> dict:
    ensure_internal_auth(x_edge_token)
    peer = state.peers.pop(device_id, None)
    if peer:
        delete_awg_peer(peer)
        persist()
    return {"status": "ok"}


@app.post("/peers/{device_id}/suspend")
def suspend_peer(device_id: int, x_edge_token: str | None = Header(default=None)) -> dict:
    ensure_internal_auth(x_edge_token)
    peer = state.peers.get(device_id)
    if peer and peer.status == "active":
        awg_remove_peer(peer.public_key)
        peer.status = "suspended"
        persist()
    return {"status": "ok"}


@app.post("/peers/{device_id}/resume")
def resume_peer(device_id: int, x_edge_token: str | None = Header(default=None)) -> dict:
    ensure_internal_auth(x_edge_token)
    peer = state.peers.get(device_id)
    if peer and peer.status != "active":
        awg_apply_peer(peer)
        peer.status = "active"
        persist()
    return {"status": "ok"}
