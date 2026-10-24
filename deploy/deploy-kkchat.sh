#!/usr/bin/env bash
# 发布 KKChat 到吉隆坡生产机。在构建机（Cloud Agent）上执行，不在 3.6GB 的生产机上构建。
#
#   INFRA_DIR=../infra deploy/deploy-kkchat.sh            # 构建 + 上传 + 备份 + 迁移 + 切换
#   INFRA_DIR=../infra deploy/deploy-kkchat.sh --rollback # 切回上一个版本目录（不动数据库）
#
# 连接只用 infra/deploy/lib/my-prod-ssh.sh（MY_PROD_*，固定 known_hosts，拒绝香港旧机器）。
# 数据库：迁移前 pg_dump -Fc 一致性备份并用 pg_restore --list 校验；迁移只增不删；不 reset、不 db push。
# 失败时：探活不过自动切回上一个版本目录；新写入的数据保留，不用旧库覆盖。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFRA_DIR="${INFRA_DIR:-$ROOT/../infra}"
# shellcheck source=/dev/null
source "$INFRA_DIR/deploy/lib/my-prod-ssh.sh"
my_prod_prepare

remote() { my_prod_ssh "$MY_PROD_SSH_TARGET" "$@"; }

if [[ "${1:-}" == "--rollback" ]]; then
  remote 'set -euo pipefail
    prev=$(sudo cat /opt/kkchat/PREVIOUS_RELEASE)
    [ -d "/opt/kkchat/releases/$prev" ] || { echo "no previous release"; exit 1; }
    cur=$(systemctl show kkchat.service -p WorkingDirectory --value | xargs basename)
    sudo sed -i "s#^WorkingDirectory=.*#WorkingDirectory=/opt/kkchat/releases/$prev#" /etc/systemd/system/kkchat.service
    echo "$cur" | sudo tee /opt/kkchat/PREVIOUS_RELEASE >/dev/null
    sudo systemctl daemon-reload && sudo systemctl restart kkchat.service
    sleep 3; curl -fsS --max-time 10 "http://127.0.0.1:3210/api/health?ready=1"; echo; echo "rolled back to $prev"'
  exit 0
fi

cd "$ROOT"
SHA="$(git rev-parse --short=7 HEAD)"
if [[ -n "$(git status --porcelain -- src prisma package.json package-lock.json shared)" ]]; then
  echo "工作区有未提交改动，先提交再发布。" >&2
  exit 1
fi

echo "== build $SHA"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
STAGE="$(mktemp -d)"
REL="$STAGE/$SHA"
mkdir -p "$REL"
cp -a .next/standalone/. "$REL/"
# standalone 会把构建机的 .env 一起带上；生产只认 /etc/kkchat.env。
rm -f "$REL"/.env "$REL"/.env.*
mkdir -p "$REL/.next"
cp -a .next/static "$REL/.next/static"
cp -a prisma "$REL/prisma"
# 迁移用的 Prisma CLI 与引擎随版本一起发，生产机不需要联网安装。
mkdir -p "$REL/node_modules/@prisma"
cp -a node_modules/prisma "$REL/node_modules/prisma"
cp -a node_modules/@prisma/engines "$REL/node_modules/@prisma/engines"
cp -a node_modules/@prisma/engines-version "$REL/node_modules/@prisma/engines-version" 2>/dev/null || true
cp -a node_modules/@prisma/debug "$REL/node_modules/@prisma/debug" 2>/dev/null || true
cp -a node_modules/@prisma/get-platform "$REL/node_modules/@prisma/get-platform" 2>/dev/null || true
cp -a node_modules/@prisma/fetch-engine "$REL/node_modules/@prisma/fetch-engine" 2>/dev/null || true
echo "$(git rev-parse HEAD)" > "$REL/RELEASE_SHA"
# Next 写出的 standalone 目录是 700、server.js 是 600。版本目录里没有密钥，统一成可读，
# 否则下次发布时 rsync --copy-dest 读不了线上版本，只能整包重传。
chmod -R u+rwX,go+rX,go-w "$REL"

# 到吉隆坡的上行很慢：用 rsync --copy-dest 对比线上当前版本，内容相同的文件（Next 运行时、sharp、Prisma 引擎）
# 在服务器上本地复制，只传真正变化的文件。
CURRENT="$(remote "systemctl show kkchat.service -p WorkingDirectory --value")"
echo "== upload (rsync against $CURRENT)"
rsync -az --checksum --delete --copy-dest="$CURRENT" \
  -e "ssh $(printf '%q ' "${MY_PROD_SSH_BASE[@]}")" \
  "$REL/" "$MY_PROD_SSH_TARGET:/tmp/kkchat-stage-$SHA/"
rm -rf "$STAGE"

remote "set -euo pipefail
  SHA=$SHA
  TS=\$(date -u +%Y%m%dT%H%M%SZ)
  sudo mkdir -p /opt/kkchat/releases /var/backups/kkchat /var/lib/kkchat/attachments /var/www/kkchat-downloads/android
  sudo chown -R kkchat:kkchat /var/lib/kkchat
  sudo chmod 700 /var/lib/kkchat/attachments
  sudo rm -rf /opt/kkchat/releases/\$SHA
  sudo mv /tmp/kkchat-stage-\$SHA /opt/kkchat/releases/\$SHA
  sudo chown -R kkchat:kkchat /opt/kkchat/releases/\$SHA

  echo '== backup'
  sudo -u postgres pg_dump -Fc kkchat | sudo tee /var/backups/kkchat/kkchat-before-\$SHA-\$TS.dump >/dev/null
  sudo chmod 600 /var/backups/kkchat/kkchat-before-\$SHA-\$TS.dump
  sudo pg_restore --list /var/backups/kkchat/kkchat-before-\$SHA-\$TS.dump | grep -c 'TABLE DATA' | xargs echo 'tables in backup:'

  echo '== migrate'
  # 只取 DATABASE_URL，不 source 整个 env 文件（里面有带空格、未加引号的值）。
  DBURL=\$(sudo grep -E '^DATABASE_URL=' /etc/kkchat.env | head -1 | cut -d= -f2- | sed -E 's/^\"(.*)\"\$/\\1/')
  sudo env DATABASE_URL=\"\$DBURL\" bash -c 'cd /opt/kkchat/releases/$SHA && node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma'

  echo '== switch'
  cur=\$(systemctl show kkchat.service -p WorkingDirectory --value | xargs basename)
  echo \"\$cur\" | sudo tee /opt/kkchat/PREVIOUS_RELEASE >/dev/null
  # /etc/kkchat.env 是 640 root:kkchat，读也要 sudo；否则 grep 失败会每次追加一行重复配置。
  if sudo grep -q '^KKCHAT_RELEASE_SHA=' /etc/kkchat.env; then
    sudo sed -i \"s#^KKCHAT_RELEASE_SHA=.*#KKCHAT_RELEASE_SHA=\$SHA#\" /etc/kkchat.env
  else
    echo \"KKCHAT_RELEASE_SHA=\$SHA\" | sudo tee -a /etc/kkchat.env >/dev/null
  fi
  sudo grep -q '^KKCHAT_ATTACHMENT_DIR=' /etc/kkchat.env || echo 'KKCHAT_ATTACHMENT_DIR=/var/lib/kkchat/attachments' | sudo tee -a /etc/kkchat.env >/dev/null
  sudo grep -q '^ReadWritePaths=' /etc/systemd/system/kkchat.service || sudo sed -i 's#^PrivateTmp=true#PrivateTmp=true\nReadWritePaths=/var/lib/kkchat#' /etc/systemd/system/kkchat.service  sudo sed -i \"s#^WorkingDirectory=.*#WorkingDirectory=/opt/kkchat/releases/\$SHA#\" /etc/systemd/system/kkchat.service
  sudo systemctl daemon-reload
  sudo systemctl restart kkchat.service
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    if curl -fsS --max-time 5 'http://127.0.0.1:3210/api/health?ready=1' >/tmp/kkchat-health.json 2>/dev/null; then
      cat /tmp/kkchat-health.json; echo; echo \"deployed \$SHA (previous \$cur)\"; exit 0
    fi
  done
  echo '探活失败，切回上一个版本目录（数据库保留新迁移，迁移只增不删，旧版本可运行）' >&2
  sudo sed -i \"s#^WorkingDirectory=.*#WorkingDirectory=/opt/kkchat/releases/\$cur#\" /etc/systemd/system/kkchat.service
  sudo systemctl daemon-reload && sudo systemctl restart kkchat.service
  sudo journalctl -u kkchat.service -n 40 --no-pager
  exit 1"
