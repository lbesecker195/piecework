#!/usr/bin/env bash
#
# Piecework — one-shot deploy for the Ubuntu box. Safe to re-run; re-running is how you redeploy.
#
#   sudo bash deploy/vps/install.sh --domain piecework.example.com --email you@example.com
#   sudo bash /var/www/HoneyTrap/piecework/deploy/vps/install.sh --yes      # redeploy (pulls main)
#
# Without a checkout yet:
#   curl -fsSL https://raw.githubusercontent.com/lbesecker195/piecework/main/deploy/vps/install.sh \
#     | sudo bash -s -- --domain piecework.example.com --email you@example.com
#
# It keeps the keys it has already generated, only restarts what it changed, and refuses to touch
# the other services on this machine. Flags:
#   --domain <fqdn>   public hostname (remembered in /etc/piecework.env after the first run)
#   --email <addr>    Let's Encrypt contact
#   --no-ssl          skip certbot (DNS not pointed here yet); BASE_URL becomes http://
#   --test-mode       run with the faucet on (default is live: faucet off, two-key payments)
#   --branch <name>   default main
#   --yes             never prompt

set -euo pipefail

SERVICE=piecework; APP_USER=piecework
APP_DIR=/var/www/HoneyTrap/piecework; DATA_DIR=/var/lib/piecework; ENV_FILE=/etc/piecework.env
REPO_URL=https://github.com/lbesecker195/piecework.git; BRANCH=main
PORT=4020; NGINX_SITE=piecework
DOMAIN=""; LE_EMAIL=""; DO_SSL=1; ASSUME_YES=0; MODE=live

step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --email) LE_EMAIL="${2:?}"; shift 2 ;;
    --no-ssl) DO_SSL=0; shift ;;
    --test-mode) MODE=test; shift ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

ask() {
  local prompt="$1" default="${2:-}" answer
  if [[ $ASSUME_YES -eq 1 ]]; then [[ -n $default ]] && { printf '%s' "$default"; return; }; die "$prompt (needed, and --yes was given)"; fi
  read -rp "    $prompt " answer </dev/tty; printf '%s' "${answer:-$default}"
}

step "Preflight"
[[ $EUID -eq 0 ]] || die "run with sudo"
command -v apt-get >/dev/null || die "this script is for Debian/Ubuntu"
if [[ -f $ENV_FILE ]]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  [[ -n $DOMAIN ]] || DOMAIN="${BASE_URL#*://}"
  [[ -n ${PIECEWORK_MODE:-} && $MODE == live ]] && MODE="$PIECEWORK_MODE"
  ok "read $ENV_FILE (keeping its keys)"
fi
[[ -n $DOMAIN ]] || DOMAIN=$(ask "public hostname for Piecework (e.g. piecework.example.com):")
[[ -n $DOMAIN ]] || die "a domain is required"
if ss -lntp 2>/dev/null | grep -q ":$PORT " && ! systemctl is-active --quiet "$SERVICE"; then
  die "port $PORT is in use by something that is not $SERVICE"
fi
ok "deploying $DOMAIN in $MODE mode"

step "System packages"
missing=()
for pkg in git nginx curl openssl ca-certificates iproute2; do dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg"); done
if [[ ${#missing[@]} -gt 0 ]]; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  ok "installed: ${missing[*]}"
else ok "all present"; fi
node_major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [[ ${node_major:-0} -lt 22 ]]; then
  # node:sqlite needs 22.5+. NodeSource keeps /usr/bin/node, which the unit file expects.
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  ok "installed node $(node -v)"
else ok "node $(node -v)"; fi

step "Service user and directories"
id "$APP_USER" >/dev/null 2>&1 || { adduser --system --group --home "$APP_DIR" --no-create-home "$APP_USER" >/dev/null; ok "created $APP_USER"; }
mkdir -p "$DATA_DIR" "$(dirname "$APP_DIR")"
chown "$APP_USER:$APP_USER" "$DATA_DIR"; chmod 750 "$DATA_DIR"
ok "$DATA_DIR ready"

step "Code"
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR" || git config --global --add safe.directory "$APP_DIR"
if [[ -d $APP_DIR/.git ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
  ok "updated to $(git -C "$APP_DIR" rev-parse --short HEAD)"
else
  git clone -q -b "$BRANCH" "$REPO_URL" "$APP_DIR"
  ok "cloned $(git -C "$APP_DIR" rev-parse --short HEAD)"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" env HOME="$APP_DIR" bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"
ok "dependencies installed"

# Decide TLS before writing BASE_URL so the app advertises the right scheme.
resolved=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
my_ip=$(curl -sf --max-time 5 https://api.ipify.org || true)
if [[ $DO_SSL -eq 1 && -n $my_ip && $resolved != "$my_ip" ]]; then
  warn "$DOMAIN resolves to '${resolved:-nothing}' but this machine is $my_ip; skipping TLS until DNS points here"
  DO_SSL=0
fi
SCHEME=$([[ $DO_SSL -eq 1 ]] && echo https || echo http)

step "Environment file"
GIT_MASTER_KEY="${GIT_MASTER_KEY:-pwgm_$(openssl rand -hex 24)}"
OWNER_KEY="${OWNER_KEY:-pwown_$(openssl rand -hex 24)}"
umask 077
cat > "$ENV_FILE" <<ENVEOF
# Written by deploy/vps/install.sh. Safe to edit; re-running preserves the keys.
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DB_PATH=$DATA_DIR/piecework.db
BASE_URL=$SCHEME://$DOMAIN
PIECEWORK_MODE=$MODE
GIT_MASTER_KEY=$GIT_MASTER_KEY
OWNER_KEY=$OWNER_KEY
GITHUB_TOKEN=${GITHUB_TOKEN:-}
LETSENCRYPT_EMAIL=${LE_EMAIL:-${LETSENCRYPT_EMAIL:-}}
ENVEOF
umask 022
chown "root:$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
ok "$ENV_FILE written"

step "systemd"
sed -e "s#/var/www/HoneyTrap/piecework#$APP_DIR#g" -e "s#/var/lib/piecework#$DATA_DIR#g" \
    "$APP_DIR/deploy/vps/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
for _ in $(seq 1 20); do curl -sf "http://127.0.0.1:$PORT/v1" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/v1" >/dev/null 2>&1 || { journalctl -u "$SERVICE" -n 30 --no-pager >&2; die "$SERVICE did not come up"; }
ok "$SERVICE is up on 127.0.0.1:$PORT"

step "nginx"
site_conf="/etc/nginx/sites-available/$NGINX_SITE"
if [[ -f $site_conf ]] && grep -q ssl_certificate "$site_conf"; then
  ok "site exists and certbot has edited it; leaving it alone"
else
  sed -e "s/server_name piecework\.example\.com;/server_name $DOMAIN;/" -e "s/server 127\.0\.0\.1:4020;/server 127.0.0.1:$PORT;/" \
      "$APP_DIR/deploy/vps/nginx-piecework.conf" > "$site_conf"
  ln -sf "$site_conf" "/etc/nginx/sites-enabled/$NGINX_SITE"
  ok "site written for $DOMAIN"
fi
nginx -t 2>/dev/null || die "nginx config invalid; nothing reloaded"
systemctl reload nginx; ok "nginx reloaded"

if [[ $DO_SSL -eq 1 ]]; then
  step "TLS"
  dpkg -s certbot >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
  if [[ -d /etc/letsencrypt/live/$DOMAIN ]]; then ok "certificate already issued"; else
    [[ -n ${LE_EMAIL:-${LETSENCRYPT_EMAIL:-}} ]] || LE_EMAIL=$(ask "contact address for Let's Encrypt:")
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "${LE_EMAIL:-$LETSENCRYPT_EMAIL}" --redirect
    ok "certificate issued"
  fi
fi
command -v ufw >/dev/null && ufw status | grep -q "^Status: active" && { ufw allow 'Nginx Full' >/dev/null 2>&1 || true; }

step "Done"
echo "    service   systemctl status $SERVICE · journalctl -u $SERVICE -f"
echo "    site      $SCHEME://$DOMAIN/   feed: $SCHEME://$DOMAIN/feed"
echo "    admin     $SCHEME://$DOMAIN/admin?key=<GIT_MASTER_KEY or OWNER_KEY from $ENV_FILE>"
echo "    keys      grep -E 'KEY=' $ENV_FILE"
echo "    redeploy  sudo bash $APP_DIR/deploy/vps/install.sh --yes"
