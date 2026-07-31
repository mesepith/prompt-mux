#!/usr/bin/env bash
# PromptMux — one-shot Ubuntu 22.04/24.04 production setup.
# Run from the project root: sudo bash deploy/ubuntu-setup.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo bash deploy/ubuntu-setup.sh"; exit 1; fi
APP_USER="${SUDO_USER:-$USER}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> [1/5] System packages"
apt-get update
apt-get install -y curl gnupg ca-certificates nginx

echo "==> [2/5] Node.js 22 (NodeSource)"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [3/5] MongoDB 8"
if ! command -v mongod >/dev/null; then
  . /etc/os-release
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update
  apt-get install -y mongodb-org
fi
systemctl enable --now mongod
sleep 2
mongod --version | head -1

echo "==> [4/5] App dependencies + production build"
sudo -u "$APP_USER" bash -c "
  cd '$PROJECT_ROOT'
  npm run install:all
  npm run build
  [[ -f server/.env ]] || cp server/.env.example server/.env
  mkdir -p logs
"

echo "==> [5/5] PM2"
npm install -g pm2
sudo -u "$APP_USER" bash -c "
  cd '$PROJECT_ROOT'
  pm2 start deploy/ecosystem.config.cjs
  pm2 save
"
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" || true

cat <<EOF

Done. Next steps:
  1. Edit $PROJECT_ROOT/server/.env — add your provider API keys AND set
     APP_PASSWORD. Until it is set, anyone who can reach port 5050 can read
     every conversation, including text extracted from your uploaded PDFs.
  2. sudo -u $APP_USER pm2 restart prompt-mux --update-env
  3. (Optional) TLS/domain: edit deploy/nginx.conf, copy to
     /etc/nginx/sites-available/promptmux, symlink to sites-enabled,
     then: sudo nginx -t && sudo systemctl reload nginx
     and:  sudo certbot --nginx -d your-domain.com

App is live on http://$(hostname -I | awk '{print $1}'):5050
EOF
