import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { BitrixClient } from '../bitrix/client.js';
import type { DealDirectory } from '../bitrix/deals.js';
import { syncActivities } from '../bitrix/sync.js';
import { returnDueCallbacks } from '../cards/service.js';
import { getSetting } from '../db/settings.js';
import { autoRelease } from '../okc/service.js';
import { syncMeetingStages } from '../okc/bitrix.js';

const SYNC_EVERY_MS = 5 * 60_000;
const CALLBACKS_EVERY_MS = 60_000;
/** Событие из Битрикс24 запускает синхронизацию не сразу: дела часто создаются пачкой */
const DEBOUNCE_MS = 5_000;

/**
 * Фоновые задачи: раз в минуту возвращает в очередь подошедшие перезвоны,
 * раз в 5 минут (и сразу по событию из Битрикс24) забирает новые дела-триггеры.
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private running: Promise<{ imported: number; skipped: number }> | null = null;

  constructor(private db: Db, private bx: BitrixClient, private dir: DealDirectory, private phoneKey: Buffer, private log: FastifyBaseLogger) {}

  start() {
    this.timers.push(setInterval(() => void this.callbacks(), CALLBACKS_EVERY_MS));
    this.timers.push(setInterval(() => void this.syncNow(), SYNC_EVERY_MS));
    this.timers.push(setInterval(() => void this.okc(), SYNC_EVERY_MS));
    void this.callbacks();
    setTimeout(() => void this.syncNow(), 10_000);
  }

  stop() {
    this.timers.forEach(clearInterval);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.okcDebounce) clearTimeout(this.okcDebounce);
  }

  triggerSync() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(), DEBOUNCE_MS);
  }

  private okcDebounce: NodeJS.Timeout | null = null;

  /** ОКЦ: открепление карточек и проверка стадий сделок со встречами */
  async okc() {
    try {
      const n = await autoRelease(this.db, await getSetting(this.db, 'okc'));
      if (n) this.log.info(`ОКЦ: откреплено карточек: ${n}`);
      const r = await syncMeetingStages(this.db, this.bx, this.log);
      if (r.done || r.failed) this.log.info(`ОКЦ: встреч состоялось ${r.done}, не состоялось ${r.failed}`);
    } catch (err) {
      this.log.error({ err }, 'Ошибка задач ОКЦ');
    }
  }

  triggerOkcSync() {
    if (this.okcDebounce) clearTimeout(this.okcDebounce);
    this.okcDebounce = setTimeout(() => void this.okc(), DEBOUNCE_MS);
  }

  /** Одна синхронизация за раз: повторный вызов ждёт текущую. */
  syncNow() {
    this.running ??= syncActivities(this.db, this.bx, this.dir, this.phoneKey, this.log)
      .catch((err) => {
        this.log.error({ err }, 'Ошибка синхронизации');
        return { imported: 0, skipped: 0 };
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async callbacks() {
    try {
      const n = await returnDueCallbacks(this.db);
      if (n) this.log.info(`В очередь вернулись перезвоны: ${n}`);
    } catch (err) {
      this.log.error({ err }, 'Ошибка возврата перезвонов');
    }
  }
}
