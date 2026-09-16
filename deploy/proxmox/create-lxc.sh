#!/bin/sh
# Run on the Proxmox node. Creates an unprivileged Debian LXC prepared for Docker.
#   CTID=120 HOSTNAME=psrp BRIDGE=vmbr0 STORAGE=local-lvm ./create-lxc.sh
# Optional: IP=192.168.1.60/24 GATEWAY=192.168.1.1 (default DHCP), CORES=4, MEMORY=4096,
# DISK=16, SSH_KEY=~/.ssh/id_ed25519.pub, TEMPLATE_STORAGE=local, PASSWORD=...
set -eu
CTID=${CTID:?Set CTID to a free container id}
HOSTNAME=${HOSTNAME:-psrp}
BRIDGE=${BRIDGE:-vmbr0}
STORAGE=${STORAGE:-local-lvm}
TEMPLATE_STORAGE=${TEMPLATE_STORAGE:-local}
CORES=${CORES:-4}
MEMORY=${MEMORY:-4096}
DISK=${DISK:-16}
IP=${IP:-dhcp}
GATEWAY=${GATEWAY:-}
SSH_KEY=${SSH_KEY:-}
PASSWORD=${PASSWORD:-}

if pct status "$CTID" >/dev/null 2>&1; then
    echo "Container $CTID already exists." >&2
    exit 1
fi

arch=$(dpkg --print-architecture 2>/dev/null || uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
pveam update >/dev/null
template=$(pveam available --section system | awk -v arch="$arch" '$2 ~ /^debian-[0-9]+-standard_/ && $2 ~ ("_" arch "\\.tar") {print $2}' | sort -V | tail -n 1)
[ -n "$template" ] || { echo "No Debian standard template for $arch offered by pveam." >&2; exit 1; }
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$template"; then
    pveam download "$TEMPLATE_STORAGE" "$template"
fi

net="name=eth0,bridge=$BRIDGE,ip=$IP"
[ "$IP" = dhcp ] || [ -z "$GATEWAY" ] || net="$net,gw=$GATEWAY"
set -- --hostname "$HOSTNAME" --cores "$CORES" --memory "$MEMORY" --swap 0 \
    --rootfs "$STORAGE:$DISK" --net0 "$net" --unprivileged 1 \
    --features nesting=1,keyctl=1 --onboot 1 --start 1
[ -z "$SSH_KEY" ] || set -- "$@" --ssh-public-keys "$SSH_KEY"
[ -z "$PASSWORD" ] || set -- "$@" --password "$PASSWORD"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$template" "$@"

echo "Container $CTID ($HOSTNAME) is starting from $template."
echo "Next: pct push $CTID deploy/proxmox/install.sh /root/install.sh && pct exec $CTID -- sh /root/install.sh"
