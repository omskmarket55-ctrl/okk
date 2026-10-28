import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../api';

type Toast = { text: string; bad?: boolean } | null;
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast>(null);
  const show = useCallback((text: string, bad?: boolean) => setToast({ text, bad }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.bad ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast${toast.bad ? ' bad' : ''}`} role="status">{toast.text}</div>}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Загрузка данных с перезапросом по reload(). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    load().then((d) => alive && setData(d)).catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1), setData };
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-h"><h3>{title}</h3><button className="btn ghost sm" onClick={onClose} aria-label="Закрыть">✕</button></div>
        <div className="panel-b">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <div className="alert bad">{error}</div> : <div className="empty">Загружаю…</div>;
}

export function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <label className="fld">
      <span>{label}</span>
      {children}
      {error && <span className="err">{error}</span>}
    </label>
  );
}
