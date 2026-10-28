import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { useToast } from './ui';
import { fmtSeconds } from '../format';
import { CALL_STATUS } from '../types';

interface Props {
  uis: boolean;
  hasPhone: boolean;
  /** Номер для показа: маска или полный, если есть право */
  phone: string;
  /** Куда отправить «позвонить» — сервер сам подставит номер клиента */
  startUrl: string;
  /** Адрес звонков: {callsUrl}/{id} — статус, {callsUrl}/{id}/hangup — завершить */
  callsUrl: string;
  onChange: () => void;
  disabled?: boolean;
}

/** Звонок через UIS: браузер передаёт только номер карточки, номер клиента подставляет сервер. */
export function CallBar({ uis, hasPhone, phone, startUrl, callsUrl, onChange, disabled }: Props) {
  const toast = useToast();
  const [call, setCall] = useState<{ id: number; status: string } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);
  useEffect(() => {
    if (call?.status !== 'talk') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [call?.status]);

  const start = async () => {
    try {
      const r = await api<{ callId: number; status: string }>(startUrl, { body: {} });
      setCall({ id: r.callId, status: r.status });
      setSeconds(0);
      poll.current = setInterval(async () => {
        const c = await api<{ id: number; status: string }>(`${callsUrl}/${r.callId}`).catch(() => null);
        if (!c) return;
        setCall(c);
        if (['ended', 'missed', 'error'].includes(c.status) && poll.current) {
          clearInterval(poll.current);
          onChange();
        }
      }, 3000);
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  const hangup = async () => {
    if (!call) return;
    await api(`${callsUrl}/${call.id}/hangup`, { body: {} }).catch(() => undefined);
    if (poll.current) clearInterval(poll.current);
    setCall({ ...call, status: 'ended' });
    onChange();
  };

  const active = call && ['starting', 'ringing', 'talk'].includes(call.status);
  return (
    <div className="phone">
      <div>
        <div className="label">Телефон клиента</div>
        <div className="numtxt mono">{hasPhone ? phone : 'нет в Битрикс24'}</div>
      </div>
      <div className="row" style={{ marginLeft: 'auto' }}>
        {call && <span className={`pill ${call.status === 'talk' ? 'good' : call.status === 'error' || call.status === 'missed' ? 'bad' : 'warn'}`}>{CALL_STATUS[call.status] ?? call.status}</span>}
        {call?.status === 'talk' && <span className="mono">{fmtSeconds(seconds)}</span>}
        {active ? <button className="btn danger" onClick={hangup}>Завершить</button>
          : <button className="btn call" disabled={disabled || !hasPhone || !uis} onClick={start} title={!uis ? 'Телефония UIS не подключена или в профиле нет ID сотрудника UIS' : undefined}>Позвонить</button>}
      </div>
      {!uis && <small className="muted" style={{ flexBasis: '100%' }}>Звонки из браузера заработают после подключения UIS. До этого администратор может временно выдать право «Видеть полный номер клиента».</small>}
    </div>
  );
}
