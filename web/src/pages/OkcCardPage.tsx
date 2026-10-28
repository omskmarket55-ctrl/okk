import { api, errorText, type Me } from '../api';
import { Loading, useLoad, useToast } from '../components/ui';
import { OkcCardPanel } from '../components/OkcCardPanel';
import type { OkcCard } from '../types';

/** Отдельная карточка ОКЦ: из «Моих карточек» оператора или из базы у супервайзера. */
export function OkcCardPage({ me, id }: { me: Me; id: number }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<OkcCard>(`/api/okc/cards/${id}`), [id]);
  const can = (p: string) => me.permissions.includes(p);
  const action = async (path: string, body: object, text: string) => {
    try {
      const r = await api<{ ok?: boolean; error?: string; released?: number }>(`/api/okc/cards/${id}/${path}`, { body });
      if (r.ok === false) toast(r.error ?? 'Не получилось', true);
      else toast(text);
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="page-h">
        <div><a href={can('okc.base') ? '#/okc-base' : '#/okc-my'} className="small">← {can('okc.base') ? 'База обзвона' : 'Мои карточки'}</a></div>
        <div className="row">
          {can('okc.return') && ['refused', 'later', 'agreement', 'meeting_failed'].includes(data.status) && <button className="btn" onClick={() => action('return', {}, 'Карточка вернулась в общую базу обзвона')}>Вернуть в работу</button>}
          {can('okc.reassign') && data.ownerId && ['new', 'later', 'agreement', 'meeting_failed'].includes(data.status) && <button className="btn" onClick={() => action('release', {}, 'Карточка снята с оператора')}>Снять с оператора</button>}
          {can('okc.base') && data.status === 'meeting' && !data.dealId && <button className="btn" onClick={() => action('push-deal', {}, 'Сделка создана в Битрикс24')}>Отправить в Битрикс24</button>}
          {can('okc.base') && data.status === 'meeting' && <>
            <button className="btn" onClick={() => action('meeting-result', { result: 'done' }, 'Встреча состоялась, бонус начислен')}>Встреча состоялась</button>
            <button className="btn" onClick={() => action('meeting-result', { result: 'failed' }, 'Встреча не состоялась, карточка вернулась оператору')}>Не состоялась</button>
          </>}
        </div>
      </div>
      <OkcCardPanel me={me} card={data} reload={reload} />
    </>
  );
}
