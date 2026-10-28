/**
 * UIS Call API (JSON-RPC 2.0, https://callapi.uiscom.ru/v4.0).
 * Доступ — по постоянному ключу пользователя с правом «Доступ к Call API»; IP сервера должен быть в белом списке UIS.
 */
export class UisError extends Error {
  constructor(public code: number, public mnemonic: string, message: string) {
    super(message);
  }
}

type FetchFn = typeof fetch;

const BASE = 'https://callapi.uiscom.ru/v4.0';

/** Понятные сотруднику сообщения для частых ошибок UIS */
const MESSAGES: Record<string, string> = {
  ip_not_whitelisted: 'IP сервера не добавлен в белый список UIS (Аккаунт → Правила и настройки безопасности → API)',
  access_token_invalid: 'Ключ UIS неверный или удалён',
  access_token_expired: 'Срок действия ключа UIS истёк',
  access_token_blocked: 'Ключ UIS заблокирован',
  employee_not_found: 'Сотрудник не найден в UIS: проверьте ID сотрудника UIS в карточке пользователя',
  no_active_phone_number: 'У сотрудника в UIS нет активного номера: включите софтфон',
  virtual_phone_number_not_found: 'Виртуальный номер для обзвона не найден в UIS',
  contact_in_blacklist: 'Номер клиента в чёрном списке UIS',
  limit_exceeded: 'Превышен лимит запросов UIS, попробуйте через минуту',
  component_disabled: 'В UIS не подключён компонент Call API',
};

export class UisCallApi {
  constructor(private accessToken: string, private fetchFn: FetchFn = fetch, private base = BASE) {}

  get configured() {
    return Boolean(this.accessToken);
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.accessToken) throw new UisError(0, 'not_configured', 'Ключ UIS не задан (UIS_ACCESS_TOKEN)');
    const res = await this.fetchFn(this.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: { access_token: this.accessToken, ...params } }),
    });
    const body = (await res.json()) as { result?: { data: T }; error?: { code: number; message: string; data?: { mnemonic?: string } } };
    if (body.error) {
      const mnemonic = body.error.data?.mnemonic ?? '';
      throw new UisError(body.error.code, mnemonic, MESSAGES[mnemonic] ?? `UIS: ${body.error.message}`);
    }
    if (!body.result) throw new UisError(0, 'no_result', `UIS ответил без результата (HTTP ${res.status})`);
    return body.result.data;
  }

  /**
   * Звонок «сначала сотрудник, потом клиент»: UIS звонит сотруднику на софтфон, после ответа набирает клиента.
   * Сотрудник видит виртуальный номер, а не номер клиента (show_virtual_phone_number).
   */
  async startEmployeeCall(p: { employeeId: number; contact: string; virtualNumber: string; externalId: string }): Promise<number> {
    const data = await this.rpc<{ call_session_id: number }>('start.employee_call', {
      first_call: 'employee',
      switch_at_once: true,
      virtual_phone_number: p.virtualNumber,
      show_virtual_phone_number: true,
      contact: p.contact,
      employee: { id: p.employeeId },
      direction: 'out',
      external_id: p.externalId,
    });
    return data.call_session_id;
  }

  async releaseCall(callSessionId: number): Promise<void> {
    await this.rpc('release.call', { call_session_id: callSessionId });
  }
}
