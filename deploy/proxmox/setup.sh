#!/usr/bin/env bash
# One-command Proxmox installer for Player One, the browser PlayStation Remote Play server.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/fabioneves/psrp-web/main/deploy/proxmox/setup.sh)"
#
# Run it on the Proxmox node as root. It asks for a container id, address, size and
# domain, creates an unprivileged Debian LXC with Docker inside, installs the app,
# and, when a domain is given, waits for the HTTPS certificate. Every answer can be
# supplied up front through the environment (CTID, CT_HOSTNAME, BRIDGE, STORAGE, IP,
# GATEWAY, CORES, MEMORY, DISK, DOMAIN, REPO, REF) for unattended runs.
# PSRP_DRY_RUN=1 prints the commands instead of running them.
set -euo pipefail

REPO=${REPO:-https://github.com/fabioneves/psrp-web.git}
REF=${REF:-main}
RAW=${RAW:-https://raw.githubusercontent.com/fabioneves/psrp-web/$REF}
DRY=${PSRP_DRY_RUN:-0}
TTY=/dev/tty; ( : < /dev/tty ) 2>/dev/null || TTY=/dev/stdin

bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); green=$(printf '\033[32m'); yellow=$(printf '\033[33m'); red=$(printf '\033[31m'); reset=$(printf '\033[0m')
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$reset"; }
warn() { printf '%s! %s%s\n' "$yellow" "$*" "$reset"; }
fail() { printf '%s%s%s\n' "$red" "$*" "$reset" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '%s$ %s%s\n' "$dim" "$*" "$reset"; else "$@"; fi; }

ask() { # ask VAR "Question" "default"
    local var=$1 prompt=$2 default=${3:-} value
    if [ -n "${!var:-}" ]; then return; fi
    if [ -n "$default" ]; then printf '%s [%s]: ' "$prompt" "$default"; else printf '%s: ' "$prompt"; fi
    IFS= read -r value < "$TTY" || value=''
    printf -v "$var" '%s' "${value:-$default}"
}
confirm() { # confirm "Question" default(y|n)
    local answer; printf '%s [%s]: ' "$1" "$2"; IFS= read -r answer < "$TTY" || answer=''
    case "${answer:-$2}" in y|Y|yes|YES) return 0;; *) return 1;; esac
}
valid_domain() { printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'; }
valid_cidr()   { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'; }

say "${bold}Player One · Proxmox LXC setup${reset}"
say "Creates a Debian container with Docker and runs the PlayStation Remote Play server in it."

if ! command -v pct >/dev/null 2>&1 && [ "$DRY" != 1 ]; then
    fail "pct not found. Run this on a Proxmox VE node. On a plain Debian machine or an existing container, run the installer directly:
  curl -fsSL $RAW/deploy/proxmox/install.sh | REMOTE_PLAY_DOMAIN=play.example.com sh"
fi
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || fail "Run as root on the Proxmox node."

step "Container"
next_id=$( { command -v pvesh >/dev/null 2>&1 && pvesh get /cluster/nextid 2>/dev/null; } || echo 120)
ask CTID "Container id" "$next_id"
[ "$DRY" = 1 ] || ! pct status "$CTID" >/dev/null 2>&1 || fail "Container $CTID already exists."
ask CT_HOSTNAME "Hostname" "psrp"
default_bridge=$( { ls /sys/class/net 2>/dev/null | grep -m1 '^vmbr'; } || echo vmbr0)
ask BRIDGE "Network bridge" "$default_bridge"
default_storage=$( { command -v pvesm >/dev/null 2>&1 && pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}'; } || echo local-lvm)
ask STORAGE "Storage for the container disk" "$default_storage"
ask IP "Address (dhcp, or a static CIDR like 192.168.1.60/24)" "dhcp"
if [ "$IP" != dhcp ]; then
    valid_cidr "$IP" || fail "Address must be 'dhcp' or an IPv4 CIDR such as 192.168.1.60/24."
    default_gw=$(printf '%s' "$IP" | sed -E 's#\.[0-9]+/[0-9]+$#.1#')
    ask GATEWAY "Gateway" "$default_gw"
fi
ask CORES "CPU cores (2 for H.264/H.265 only, 4 if you also use Canvas mode)" "4"
ask MEMORY "Memory in MB" "2048"
ask DISK "Disk in GB" "16"

step "Domain (HTTPS)"
say "Browsers only allow H.264/H.265 decoding on HTTPS, and a Tesla needs a public hostname,"
say "so a domain is strongly recommended. Leave it empty to run on plain HTTP for now."
ask DOMAIN "Domain for this server (for example play.example.com)" ""
DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
if [ -n "$DOMAIN" ]; then
    valid_domain "$DOMAIN" || fail "'$DOMAIN' is not a valid hostname."
    say "Before the certificate can be issued, the following must be true:"
    say "  1. A DNS A record for $DOMAIN points at your public IP."
    say "  2. Your router forwards public TCP 80 and 443 to the container's address."
    confirm "Continue? You can also finish DNS and forwarding after the install" y || exit 1
fi

step "Summary"
say "  Container   $CTID ($CT_HOSTNAME) on $BRIDGE, $CORES cores, ${MEMORY} MB, ${DISK} GB on $STORAGE"
say "  Address     $IP${GATEWAY:+ via $GATEWAY}"
say "  Domain      ${DOMAIN:-none (HTTP only)}"
say "  Source      $REPO ($REF)"
confirm "Create the container and install now?" y || exit 1

step "Downloading the newest Debian template"
if [ "$DRY" = 1 ]; then template=debian-13-standard_13.0-1_amd64.tar.zst; else
    pveam update >/dev/null
    template=$(pveam available --section system | awk '/debian-[0-9]+-standard/ {print $2}' | sort -V | tail -n 1)
    [ -n "$template" ] || fail "No Debian standard template offered by pveam."
    template_storage=${TEMPLATE_STORAGE:-local}
    pveam list "$template_storage" | grep -q "$template" || pveam download "$template_storage" "$template"
fi
template_storage=${TEMPLATE_STORAGE:-local}

step "Creating container $CTID"
net="name=eth0,bridge=$BRIDGE,ip=$IP"
[ "$IP" = dhcp ] || net="$net,gw=$GATEWAY"
password=$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | head -c 16)
run pct create "$CTID" "$template_storage:vztmpl/$template" --hostname "$CT_HOSTNAME" --cores "$CORES" --memory "$MEMORY" --swap 0 \
    --rootfs "$STORAGE:$DISK" --net0 "$net" --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1 --password "$password" --start 1

step "Waiting for the container network"
address=''
if [ "$DRY" = 1 ]; then address=192.0.2.10; else
    for _ in $(seq 1 40); do
        address=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}') && [ -n "$address" ] && break
        sleep 3
    done
    [ -n "$address" ] || fail "The container did not get an address. Check the bridge and DHCP, then rerun."
fi
say "Container address: $address"

step "Installing Docker and the app (this builds the image; expect several minutes)"
run pct exec "$CTID" -- bash -c "curl -fsSL '$RAW/deploy/proxmox/install.sh' -o /root/install.sh && REPO='$REPO' REF='$REF' REMOTE_PLAY_DOMAIN='$DOMAIN' sh /root/install.sh"

if [ -n "$DOMAIN" ] && [ "$DRY" != 1 ]; then
    step "Checking $DOMAIN"
    public_ip=$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || true)
    resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
    if [ -z "$resolved" ]; then warn "$DOMAIN does not resolve yet. Create the DNS A record${public_ip:+ pointing at $public_ip}."
    elif [ -n "$public_ip" ] && [ "$resolved" != "$public_ip" ]; then warn "$DOMAIN resolves to $resolved but this network's public IP is $public_ip."
    else say "$DOMAIN resolves to $resolved."; fi
    say "Waiting up to two minutes for the certificate (needs DNS and ports 80/443 forwarded to $address)…"
    issued=0
    for _ in $(seq 1 24); do
        if curl -fsS -m 8 "https://$DOMAIN/healthz" >/dev/null 2>&1; then issued=1; break; fi
        sleep 5
    done
    if [ "$issued" = 1 ]; then say "${green}HTTPS is live: https://$DOMAIN/${reset}"
    else warn "No certificate yet. Caddy keeps retrying inside the container; once DNS and forwarding are in place it will succeed. Check with: pct exec $CTID -- docker compose -f /opt/psrp/compose.yaml logs proxy"; fi
fi

step "Done"
say "  Local address   http://$address:8080"
[ -z "$DOMAIN" ] || say "  Public address  https://$DOMAIN/"
say "  Root password   $password   (for 'pct enter $CTID' or SSH; change it with 'pct exec $CTID -- passwd')"
say "  App directory   /opt/psrp in the container"
say "  Update          pct exec $CTID -- psrp update      (refuses while a stream is running)"
say "  Status / logs   pct exec $CTID -- psrp status  ·  pct exec $CTID -- psrp logs"
say "  Tesla           open the public address in the car and use 'Open in Tesla theater' for fullscreen"
say "Next: create a local account, then pair the console with Sign in to PSN."
