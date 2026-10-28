import qs from 'qs';

export interface BitrixResponse<T> {
  result: T;
  next?: number;
  total?: number;
}

export class BitrixError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message || code);
  }
}

type FetchFn = typeof fetch;

/** Битрикс24 допускает около 2 запросов в секунду на портал: все запросы идут через одну очередь. */
const MIN_INTERVAL_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Клиент REST API через входящий вебхук: очередь запросов, повтор при превышении лимита,
 * постраничная выборка. Адрес вебхука — секрет, он хранится только в .env на сервере.
 */
export class BitrixClient {
  private queue: Promise<void> = Promise.resolve();

  constructor(private webhookUrl: string, private fetchFn: FetchFn = fetch, private intervalMs = MIN_INTERVAL_MS) {}

  get configured() {
    return Boolean(this.webhookUrl);
  }

  /** Адрес портала: https://портал.bitrix24.ru — для ссылок на сделки и лиды */
  get portalUrl(): string {
    return this.webhookUrl ? new URL(this.webhookUrl).origin : '';
  }

  private throttle(): Promise<void> {
    const prev = this.queue;
    this.queue = prev.then(() => sleep(this.intervalMs));
    return prev;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<BitrixResponse<T>> {
    if (!this.webhookUrl) throw new BitrixError('not_configured', 'Входящий вебхук Битрикс24 не задан (BITRIX_WEBHOOK_URL)', 0);
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await this.fetchFn(`${this.webhookUrl}${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs.stringify(params),
      });
      const text = await res.text();
      let body: BitrixResponse<T> & { error?: string; error_description?: string };
      try {
        body = JSON.parse(text);
      } catch {
        throw new BitrixError('bad_response', `Битрикс24 ответил не JSON (HTTP ${res.status})`, res.status);
      }
      if (!body.error) return body;
      if ((body.error === 'QUERY_LIMIT_EXCEEDED' || res.status === 503) && attempt < 3) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new BitrixError(body.error, body.error_description ?? '', res.status);
    }
  }

  async result<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.call<T>(method, params)).result;
  }

  /** Все страницы списочного метода (по 50 записей), но не больше maxItems. */
  async listAll<T>(method: string, params: Record<string, unknown> = {}, maxItems = 5000): Promise<T[]> {
    const items: T[] = [];
    let start: number | undefined = 0;
    while (start !== undefined && items.length < maxItems) {
      const page: BitrixResponse<T[]> = await this.call<T[]>(method, { ...params, start });
      items.push(...page.result);
      start = page.next;
    }
    return items.slice(0, maxItems);
  }
}
