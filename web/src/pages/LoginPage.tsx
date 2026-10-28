import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { Field } from '../components/ui';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/login', { body: { login, password } });
      onLogin();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="panel" onSubmit={submit}>
        <div className="panel-h"><div className="brand" style={{ padding: 0 }}><i>ОКК</i>Контроль качества</div></div>
        <div className="panel-b stack">
          <Field label="Логин"><input id="login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus /></Field>
          <Field label="Пароль"><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <div className="err">{error}</div>}
          <button className="btn primary" disabled={busy || !login || !password}>Войти</button>
        </div>
      </form>
    </div>
  );
}
