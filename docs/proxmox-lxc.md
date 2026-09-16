# Proxmox LXC deployment

Runs the project in an unprivileged Debian LXC with rootful Docker inside and
host networking, so the console's UDP stream reaches the app through the kernel
alone and discovery and wake use LAN broadcasts. Docker Compose on any other
host keeps working exactly as described in the README; this is the alternative
for a Proxmox environment.

## Quick path

One command on the Proxmox node does everything below, asking for each value:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/fabioneves/psrp-web/main/deploy/proxmox/setup.sh)"
```

Set `PSRP_DRY_RUN=1` to see the commands it would run. The manual steps
follow for anyone who prefers to run them one at a time.

## 1. Create the container (on the Proxmox node)

```sh
git clone https://github.com/fabioneves/psrp-web.git
cd psrp-web
CTID=120 HOSTNAME=psrp BRIDGE=vmbr0 STORAGE=local-lvm \
  SSH_KEY=~/.ssh/id_ed25519.pub ./deploy/proxmox/create-lxc.sh
```

The script downloads the newest Debian standard template that `pveam` offers,
creates an unprivileged container with `nesting=1,keyctl=1` (both required by
Docker), 4 cores, 4 GB RAM and a 16 GB root disk on a bridged interface using
DHCP, and starts it. Override `IP=192.168.1.60/24 GATEWAY=192.168.1.1` for a
static address, `CORES`, `MEMORY`, `DISK`, `TEMPLATE_STORAGE` or `PASSWORD` as
needed. The running stack idles around 200 MB and H.264/H.265 sessions add
little, but `docker compose up --build`, which every update runs inside the
container, publishes the .NET app and compiles the pairing helper with four
jobs and peaks well above 1 GB with no swap configured. Both limits are
ceilings, not reservations, so the unused share stays with the node.

Give the container a DHCP reservation, or a static address, so the console and
any bookmarks keep finding it.

## 2. Install and start (inside the container)

```sh
pct push 120 deploy/proxmox/install.sh /root/install.sh
pct exec 120 -- sh /root/install.sh
```

The installer adds Docker CE from Docker's repository (falling back to the
previous Debian release's packages if the new one has none yet), clones the
repository into `/opt/psrp`, writes a `.env` with a generated database password
and `COMPOSE_FILE=compose.yaml:compose.host.yaml`, builds the image and starts
the stack. It prints the address when `/healthz` answers. Pass
`REMOTE_PLAY_DOMAIN=play.example.com` to also start the Caddy HTTPS proxy
through `compose.lxc.yaml`, which puts the proxy on the host network and
points it at the app on 127.0.0.1. Caddy listens on 80 and 443; `HTTP_PORT`
and `HTTPS_PORT` override that, and `PORT` sets the app's own port (80 when
there is no proxy, 8080 behind it).

`DISCOVERY_SUBNETS` is left empty because broadcasts work from the container's
own LAN address. Set it only if the console is on another subnet.

## 3. Move data from an existing instance (optional)

Accounts and console pairings live in PostgreSQL; the login signing secret and
the PSN token-encryption keys live in the `app-data` volume. Both must move for
saved logins and PSN sign-ins to remain valid.

On the old host:

```sh
docker compose exec -T database pg_dump -U remoteplay -Fc remoteplay > psrp.dump
docker run --rm -v tsla-psrp_app-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/app-data.tgz -C /data .
```

Replace `tsla-psrp` with the old Compose project name if it differs
(`docker volume ls` shows it). Copy both files into the container, then:

```sh
cd /opt/psrp
docker compose stop remote-play
docker compose exec -T database dropdb -U remoteplay remoteplay
docker compose exec -T database createdb -U remoteplay remoteplay
docker compose exec -T database pg_restore -U remoteplay -d remoteplay < psrp.dump
docker run --rm -v psrp_app-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/app-data.tgz -C /data'
docker compose up -d
```

`psrp_app-data` is the volume name when the project directory is `/opt/psrp`.
Delete the dump and archive afterwards; they contain credentials.

## 4. Update

From the Proxmox node:

```sh
pct exec 120 -- psrp update
```

or `psrp update` inside the container. The command refuses while a stream is
running because rebuilding ends the session (`psrp update --force` overrides),
saves the current log to `~/psrp-logs`, fast-forwards the checkout to the
branch it was installed from, rebuilds the image, waits for the health check
and prunes the previous image. `psrp status` shows the version, health and
containers; `psrp logs [n]` prints the last lines; `psrp save-log` archives
the log without updating; `psrp restart` restarts the app without a rebuild.

The equivalent by hand is `cd /opt/psrp && git pull && docker compose up --build -d`.

## Notes

- The container needs `nesting=1` and `keyctl=1`; without them Docker's
  overlay storage and containerd fail to start.
- Proxmox backups (`vzdump`) capture the whole container including both
  volumes, which is the simplest backup.
- Proxmox kernel upgrades occasionally require `systemctl restart docker`
  inside the container after the node reboots.
- The app listens on the container's address directly; there is no Docker
  port mapping in this mode, so firewall rules apply to the container IP.
