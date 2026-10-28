export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public errors?: Record<string, string>, public problems?: string[]) {
    super(message);
  }
}

/** Запрос к API. Тело — всегда JSON: сервер другие изменения не принимает. */
export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login' && path !== '/api/me') window.dispatchEvent(new Event('okk:logout'));
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Ошибка ${res.status}`, data.errors, data.problems);
  }
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Что-то пошло не так');

export interface Me {
  id: number;
  login: string;
  name: string;
  roleName: string;
  permissions: string[];
  integrations: { bitrix: boolean; uis: boolean; sms: { id: string; name: string }[] };
}
