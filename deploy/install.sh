#!/usr/bin/env bash
# Ставит или обновляет кабинет ОКК на сервере unosystem рядом с другими проектами.
# Код в /opt/okk кладёт okk-bootstrap.sh из репозитория unosystem-site, он же запускает этот скрипт.
#
# PostgreSQL и приложение — в Docker (проект «okk»), наружу портов не открывают.
# HTTPS для okk.unosystem.ru — на общем входном Caddy: приложение доступно ему как okk-app:3000
# в сети «unosystem». Вход настраивает установщик unosystem-site, этот скрипт вызывает его в конце.
# Повторный запуск безопасен: обновляет код и пересобирает приложение, .env не трогает.
set -euo pipefail

SRC=/opt/okk
ENV_FILE=$SRC/.env
NET=unosystem
DOMAIN=okk.unosystem.ru
UPDATER=/usr/local/sbin/okk-update
BACKUP=/usr/local/sbin/okk-backup
SITE_INSTALLER=https://raw.githubusercontent.com/omskmarket55-ctrl/unosystem-site/main/deploy/install.sh

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

secret() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
env_get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
# Записывает KEY=значение в .env, не интерпретируя спецсимволы значения
env_set() {
  local tmp
  tmp=$(mktemp)
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] } index($0, k "=") == 1 { print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

# Спрашивает секрет с клавиатуры, если его ещё нет в .env. Ввод не виден.
ask_secret() {
  local key=$1 prompt=$2 value=''
  [ -n "$(env_get "$key")" ] && return 0
  { : < /dev/tty; } 2> /dev/null || return 0
  printf '%s (Enter — пропустить): ' "$prompt" > /dev/tty
  read -rs value < /dev/tty || true
  printf '\n' > /dev/tty
  if [ -n "$value" ]; then
    env_set "$key" "$value"
    ok "$key сохранён в $ENV_FILE"
  fi
}

main() {
  [ "$(id -u)" -eq 0 ] || die "Нужен root: запустите через sudo"
  command -v docker > /dev/null || die "Не найден Docker"
  docker compose version > /dev/null 2>&1 || die "Не найден docker compose (плагин Docker Compose v2)"
  cd "$SRC"

  # 1. Настройки. Секреты генерируются один раз и остаются только на сервере.
  local first_admin=''
  if [ ! -f "$ENV_FILE" ]; then
    touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
    first_admin=$(secret 16)
    cat > "$ENV_FILE" <<ENV
# Кабинет ОКК на сервере unosystem. Создано deploy/install.sh $(date '+%F %T')
# PHONE_KEY шифрует телефоны в базе: не меняйте и не теряйте его (храните копию .env в надёжном месте).
PUBLIC_URL=https://$DOMAIN
SESSION_SECRET=$(secret 64)
PHONE_KEY=$(head -c 32 /dev/urandom | base64)
POSTGRES_PASSWORD=$(secret 32)
INITIAL_ADMIN_LOGIN=admin
INITIAL_ADMIN_PASSWORD=$first_admin
BITRIX_WEBHOOK_URL=
BITRIX_OUTGOING_TOKEN=
UIS_ACCESS_TOKEN=
UIS_HOOK_KEY=$(secret 32)
DEMO=0
ENV
    ok "Создан $ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  ask_secret BITRIX_WEBHOOK_URL 'Адрес входящего вебхука Битрикс24 (https://….bitrix24.ru/rest/1/…/)'
  ask_secret UIS_ACCESS_TOKEN 'Ключ UIS Call API'

  # 2. Сборка и запуск
  docker network inspect "$NET" > /dev/null 2>&1 || docker network create "$NET" > /dev/null
  log "Собираю и запускаю кабинет — первый раз это несколько минут"
  docker compose up -d --build --remove-orphans
  local status=''
  for _ in $(seq 1 40); do
    status=$(docker inspect -f '{{.State.Health.Status}}' okk-app-1 2> /dev/null || true)
    [ "$status" = healthy ] && break
    sleep 3
  done
  [ "$status" = healthy ] || die "Кабинет не запустился. Пришлите: docker compose -f $SRC/docker-compose.yml logs app --tail 50"
  ok "Кабинет работает (okk-app-1)"
  docker image prune -f > /dev/null

  # 3. Автообновление из main раз в 5 минут и ночная копия базы (хранится 14 дней)
  install -m 755 "$SRC/deploy/update.sh" "$UPDATER"
  install -m 755 "$SRC/deploy/backup.sh" "$BACKUP"
  cat > /etc/systemd/system/okk-update.service <<UNIT
[Unit]
Description=ОКК: обновление из GitHub
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=$UPDATER
UNIT
  cat > /etc/systemd/system/okk-update.timer <<UNIT
[Unit]
Description=ОКК: проверка обновлений каждые 5 минут

[Timer]
OnBootSec=4min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  cat > /etc/systemd/system/okk-backup.service <<UNIT
[Unit]
Description=ОКК: копия базы данных
After=docker.service

[Service]
Type=oneshot
ExecStart=$BACKUP
UNIT
  cat > /etc/systemd/system/okk-backup.timer <<UNIT
[Unit]
Description=ОКК: копия базы каждую ночь

[Timer]
OnCalendar=*-*-* 03:20
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now okk-update.timer okk-backup.timer > /dev/null
  ok "Автообновление и ночная копия базы включены (okk-update.timer, okk-backup.timer)"

  # 4. Вход: okk.unosystem.ru → okk-app:3000
  log "Обновляю общий вход (установщик unosystem-site)"
  curl -fsSL "$SITE_INSTALLER" | bash

  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/health" || true)
  [ "$code" = 200 ] || die "$DOMAIN/health ответил $code"
  ok "Готово: https://$DOMAIN"
  if [ -n "$first_admin" ]; then
    printf '\n  Вход администратора: логин admin, пароль %s\n' "$first_admin"
    printf '  Пароль показан один раз. Смените его после входа: «Сотрудники» → «Изменить».\n'
  fi
  printf '  Адрес уведомлений UIS о звонках: https://%s/hooks/uis/%s\n' "$DOMAIN" "$(env_get UIS_HOOK_KEY)"
}

main "$@"
