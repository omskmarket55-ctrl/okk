#!/usr/bin/env bash
# Ночная копия базы ОКК: /opt/okk/backups/okk-ГГГГ-ММ-ДД.sql.gz, хранится 14 дней.
# Восстановление: gunzip -c файл.sql.gz | docker compose -f /opt/okk/docker-compose.yml exec -T db psql -U okk okk
set -euo pipefail

DIR=/opt/okk/backups
install -d -m 700 "$DIR"
docker compose -f /opt/okk/docker-compose.yml exec -T db pg_dump -U okk --clean --if-exists okk | gzip > "$DIR/okk-$(date +%F).sql.gz"
find "$DIR" -name 'okk-*.sql.gz' -mtime +14 -delete
