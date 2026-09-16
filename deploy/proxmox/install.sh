#!/bin/sh
# Run inside the LXC as root. Installs Docker CE, fetches the project and starts it
# with host networking so console discovery and wake use LAN broadcasts.
#   REPO=https://github.com/fabioneves/psrp-web.git sh install.sh
# Optional: REF=main, APP_DIR=/opt/psrp, REMOTE_PLAY_DOMAIN=play.example.com (adds the
# HTTPS proxy), HTTP_PORT=80, HTTPS_PORT=443, PORT (app port: 80 without a domain,
# 8080 behind the proxy), DB_PASSWORD=...
set -eu
REPO=${REPO:-https://github.com/fabioneves/psrp-web.git}
REF=${REF:-main}
APP_DIR=${APP_DIR:-/opt/psrp}
HTTP_PORT=${HTTP_PORT:-80}
HTTPS_PORT=${HTTPS_PORT:-443}
if [ -n "${REMOTE_PLAY_DOMAIN:-}" ]; then PORT=${PORT:-8080}; else PORT=${PORT:-$HTTP_PORT}; fi

export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
apt-get update -q
apt-get install -y -q ca-certificates curl git iproute2
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
fi
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
if ! curl -fsSI "https://download.docker.com/linux/debian/dists/$codename/Release" >/dev/null; then
    echo "Docker has no packages for Debian $codename yet; using bookworm packages." >&2
    codename=bookworm
fi
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $codename stable" \
    > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --depth 1 origin "$REF"
    git -C "$APP_DIR" checkout -q FETCH_HEAD
else
    git clone --depth 1 --branch "$REF" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
    db_password=${DB_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}
    {
        echo "PORT=$PORT"
        echo "HTTP_PORT=$HTTP_PORT"
        echo "HTTPS_PORT=$HTTPS_PORT"
        echo "DB_PASSWORD=$db_password"
        echo "DISCOVERY_SUBNETS="
        if [ -n "${REMOTE_PLAY_DOMAIN:-}" ]; then
            echo "REMOTE_PLAY_DOMAIN=$REMOTE_PLAY_DOMAIN"
            echo "COMPOSE_FILE=compose.yaml:compose.host.yaml:compose.https.yaml:compose.lxc.yaml"
        else
            echo "COMPOSE_FILE=compose.yaml:compose.host.yaml"
        fi
    } > .env
    chmod 600 .env
fi

install -m 0755 deploy/proxmox/psrp /usr/local/bin/psrp
docker compose up --build -d
until curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; do sleep 3; done
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ip" ] || ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)
if [ "$PORT" = 80 ]; then echo "Remote Play is running at http://$ip/"; else echo "Remote Play is running at http://$ip:$PORT/"; fi
echo "Later: 'psrp update' pulls and rebuilds, 'psrp status' and 'psrp logs' inspect it."
[ -z "${REMOTE_PLAY_DOMAIN:-}" ] || echo "HTTPS: https://$REMOTE_PLAY_DOMAIN (DNS must point at $ip; Caddy listens on $HTTP_PORT and $HTTPS_PORT)"
