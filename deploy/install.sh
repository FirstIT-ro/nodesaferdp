#!/usr/bin/env bash
# NodeSafeRDP server installer for Rocky Linux 10 (also fine on RHEL/Alma 9-10).
#
#   sudo ./deploy/install.sh --domain rdp.example.com --email you@example.com [--admin admin]
#
# Re-running it is safe: it updates the code and keeps config, users and certificates.
# Prerequisites: the domain's DNS A/AAAA record points at this VM, and ports 80/443 are
# reachable from the internet (port 80 is needed for Let's Encrypt validation and renewals).
set -euo pipefail

DOMAIN=""; EMAIL=""; ADMIN="admin"; PORT=8080
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --email)  EMAIL="$2"; shift 2;;
    --admin)  ADMIN="$2"; shift 2;;
    --port)   PORT="$2"; shift 2;;
    -h|--help) sed -n '2,9p' "$0"; exit 0;;
    *) echo "Unknown option $1"; exit 2;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
[[ -n "$DOMAIN" && -n "$EMAIL" ]] || { echo "Usage: $0 --domain rdp.example.com --email you@example.com [--admin admin]"; exit 2; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid domain"; exit 2; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/nodesaferdp
CONF_DIR=/etc/nodesaferdp
DATA_DIR=/var/lib/nodesaferdp
WEBROOT=/var/www/letsencrypt
SVC_USER=nodesaferdp

step() { echo -e "\n\033[1;36m==> $*\033[0m"; }

step "Installing packages"
dnf -y install epel-release >/dev/null || true
dnf -y install nodejs npm nginx openssl tar policycoreutils-python-utils >/dev/null
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ $NODE_MAJOR -ge 18 ]] || { echo "Node.js >= 18 required (found $(node -v))"; exit 1; }

if ! command -v certbot >/dev/null 2>&1; then
  if ! dnf -y install certbot >/dev/null 2>&1; then
    echo "certbot not available from dnf, installing it into a Python venv at /opt/certbot"
    dnf -y install python3 python3-pip augeas-libs >/dev/null
    python3 -m venv /opt/certbot
    /opt/certbot/bin/pip install --quiet --upgrade pip certbot
    ln -sf /opt/certbot/bin/certbot /usr/bin/certbot
  fi
fi

step "Creating service user and directories"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /sbin/nologin "$SVC_USER"
install -d -m 0755 "$APP_DIR"
install -d -m 0750 -o root -g "$SVC_USER" "$CONF_DIR"
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -d -m 0755 "$WEBROOT"

step "Installing application to $APP_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/public"
tar -C "$REPO_DIR/server" --exclude=node_modules --exclude=data --exclude=config.json -cf - . | tar -C "$APP_DIR" -xf -
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

if [[ ! -f "$CONF_DIR/config.json" ]]; then
  step "Generating configuration (new agent key)"
  AGENT_KEY=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
  cat > "$CONF_DIR/config.json" <<EOF
{
  "listenHost": "127.0.0.1",
  "port": $PORT,
  "dataDir": "$DATA_DIR",
  "agentKey": "$AGENT_KEY",
  "sessionHours": 12,
  "trustProxy": true,
  "secureCookies": true
}
EOF
fi
chown root:"$SVC_USER" "$CONF_DIR/config.json"
chmod 0640 "$CONF_DIR/config.json"
PORT=$(node -p "require('$CONF_DIR/config.json').port")

step "Installing systemd service"
cat > /etc/systemd/system/nodesaferdp.service <<EOF
[Unit]
Description=NodeSafeRDP remote control relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
Environment=NODE_ENV=production
Environment=NSR_CONFIG=$CONF_DIR/config.json
ExecStart=/usr/bin/node $APP_DIR/src/server.js
Restart=always
RestartSec=3
# hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
ReadWritePaths=$DATA_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

USER_CMD=/usr/bin/nodesaferdp-user
rm -f /usr/local/bin/nodesaferdp-user   # old location (not in root/sudo PATH on Rocky)
cat > "$USER_CMD" <<EOF
#!/bin/sh
# Manage web console users: nodesaferdp-user add|passwd|del <name> | list
exec runuser -u $SVC_USER -- env NSR_CONFIG=$CONF_DIR/config.json /usr/bin/node $APP_DIR/cli.js "\$@"
EOF
chmod 0755 "$USER_CMD"

systemctl daemon-reload
systemctl enable nodesaferdp >/dev/null
systemctl restart nodesaferdp

step "Configuring firewall and SELinux"
if systemctl is-active --quiet firewalld; then
  firewall-cmd --quiet --permanent --add-service=http --add-service=https
  firewall-cmd --quiet --reload
fi
if command -v getenforce >/dev/null && [[ "$(getenforce)" != "Disabled" ]]; then
  setsebool -P httpd_can_network_connect 1   # allow nginx -> 127.0.0.1:$PORT
  restorecon -R "$WEBROOT" || true
fi

step "Configuring nginx (HTTP for certificate validation)"
NGX=/etc/nginx/conf.d/nodesaferdp.conf
http_block() {
cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
}
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
if [[ ! -f "$CERT" ]]; then
  http_block > "$NGX"
  nginx -t
  systemctl enable --now nginx >/dev/null
  systemctl reload nginx

  step "Requesting Let's Encrypt certificate for $DOMAIN"
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --email "$EMAIL" \
    --agree-tos --non-interactive --no-eff-email
fi

step "Configuring nginx (HTTPS reverse proxy)"
{
http_block
cat <<EOF

map \$http_upgrade \$nsr_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:NSR:10m;
    ssl_session_timeout 1d;

    client_max_body_size 32m;
    server_tokens off;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$nsr_connection_upgrade;
        # WebSockets and HTTPS long-polling: no buffering, long timeouts
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
} > "$NGX"
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

step "Setting up automatic certificate renewal"
install -d /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
if systemctl list-unit-files certbot-renew.timer >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^certbot-renew.timer'; then
  systemctl enable --now certbot-renew.timer >/dev/null
else
  cat > /etc/systemd/system/nodesaferdp-certbot.service <<EOF
[Unit]
Description=Renew Let's Encrypt certificates
[Service]
Type=oneshot
ExecStart=$(command -v certbot) renew --quiet
EOF
  cat > /etc/systemd/system/nodesaferdp-certbot.timer <<EOF
[Unit]
Description=Twice-daily Let's Encrypt renewal check
[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now nodesaferdp-certbot.timer >/dev/null
fi

if ! "$USER_CMD" list | grep -q .; then
  step "Create the first web console user ($ADMIN)"
  "$USER_CMD" add "$ADMIN"
fi

sleep 1
systemctl is-active --quiet nodesaferdp || { journalctl -u nodesaferdp -n 30 --no-pager; exit 1; }
AGENT_KEY=$(node -p "require('$CONF_DIR/config.json').agentKey")

cat <<EOF

=====================================================================
 NodeSafeRDP is running:  https://$DOMAIN
 Agent key (keep secret; anyone with it can register a machine):
     $AGENT_KEY
 On each Windows PC (normal user, no admin):
     build.cmd
     NodeSafeRDP.exe --setup --server https://$DOMAIN --key <agent key>
     NodeSafeRDP.exe
 Users:   sudo nodesaferdp-user add|passwd|del <name>  /  list
 Logs:    journalctl -u nodesaferdp -f
=====================================================================
EOF
