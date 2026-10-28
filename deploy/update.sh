#!/usr/bin/env bash
# Автообновление кабинета: если в main появились изменения — забирает их и пересобирает приложение.
# install.sh кладёт копию этого файла в /usr/local/sbin/okk-update, её раз в 5 минут запускает таймер systemd.
# .env не в git, поэтому git reset его не трогает.
set -euo pipefail

SRC=/opt/okk
cd "$SRC"
git fetch -q --depth 1 origin main
if [ "${1:-}" != "--force" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  exit 0
fi
git reset -q --hard origin/main
docker compose up -d --build --remove-orphans
docker image prune -f > /dev/null
echo "$(date '+%F %T') ОКК обновлён до $(git rev-parse --short HEAD)"
