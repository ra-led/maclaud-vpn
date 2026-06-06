#!/usr/bin/env bash
set -euo pipefail

AWG_IF="${AWG_INTERFACE:-awg0}"
AWG_PORT="${AWG_PORT:-51820}"
AWG_NET="${AWG_NET:-10.77.0}"
AWG_EXT_IF="${AWG_EXT_IF:-eth0}"
AWG_SERVER_IP="${EDGE_PUBLIC_IP:-${AWG_SERVER_IP:-203.0.113.10}}"
SERVER_CONF="/etc/amnezia/amneziawg/${AWG_IF}.conf"

mkdir -p /etc/amnezia/amneziawg /etc/wireguard /root/vpn-configs/amneziawg /root/vpn-configs/qrs/amneziawg /var/run/wireguard
chmod 700 /etc/amnezia /etc/amnezia/amneziawg /root/vpn-configs /root/vpn-configs/amneziawg /root/vpn-configs/qrs /root/vpn-configs/qrs/amneziawg

if [[ ! -f "$SERVER_CONF" ]]; then
  SERVER_PRIV="$(awg genkey)"
  cat >"$SERVER_CONF" <<EOF
[Interface]
Address = ${AWG_NET}.1/24
ListenPort = ${AWG_PORT}
PrivateKey = ${SERVER_PRIV}
Jc = ${AWG_JC:-7}
Jmin = ${AWG_JMIN:-8}
Jmax = ${AWG_JMAX:-80}
S1 = ${AWG_S1:-74}
S2 = ${AWG_S2:-123}
H1 = ${AWG_H1:-827391045}
H2 = ${AWG_H2:-1940285573}
H3 = ${AWG_H3:-651273892}
H4 = ${AWG_H4:-1478293011}
PostUp = iptables -I INPUT -p udp --dport ${AWG_PORT} -j ACCEPT; iptables -I FORWARD -i ${AWG_IF} -j ACCEPT; iptables -I FORWARD -i ${AWG_EXT_IF} -o ${AWG_IF} -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -C POSTROUTING -s ${AWG_NET}.0/24 -o ${AWG_EXT_IF} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${AWG_NET}.0/24 -o ${AWG_EXT_IF} -j MASQUERADE
PostDown = iptables -D INPUT -p udp --dport ${AWG_PORT} -j ACCEPT 2>/dev/null || true; iptables -D FORWARD -i ${AWG_IF} -j ACCEPT 2>/dev/null || true; iptables -D FORWARD -i ${AWG_EXT_IF} -o ${AWG_IF} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
EOF
  chmod 600 "$SERVER_CONF"
fi

ln -sf "$SERVER_CONF" "/etc/wireguard/${AWG_IF}.conf"

sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
sysctl -w net.ipv6.conf.all.forwarding=1 >/dev/null 2>&1 || true

export WG_QUICK_USERSPACE_IMPLEMENTATION="${WG_QUICK_USERSPACE_IMPLEMENTATION:-amneziawg-go}"

cleanup() {
  awg-quick down "$AWG_IF" >/dev/null 2>&1 || true
}
trap cleanup TERM INT

awg-quick up "$AWG_IF"
echo "AmneziaWG ${AWG_IF} is up on ${AWG_SERVER_IP}:${AWG_PORT}"

while true; do
  sleep 3600 &
  wait $!
done
