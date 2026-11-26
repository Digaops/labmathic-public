import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { authStorage } from '../services/authStorage.mjs';
import { parseAccount, parsePasswordChange, parsePreferences, requestError, sameIds, uncertainWrite } from '../services/accountSupportView.mjs';
import useAccountLeave from '../hooks/useAccountLeave';
import { AccountNotice, accountPanel } from '../components/AccountWorkspace';

export default function Profile() {
  const auth = useAuth();
  return <AccountEditor key={auth.user.id} auth={auth} />;
}
function AccountEditor({ auth }) {
  const { user, setUser, replaceSessionToken, logout } = auth;
  const [area, setArea] = useState('data'), [saved, setSaved] = useState(user), [form, setForm] = useState({ name: user.name, email: user.email });
  const [emailPassword, setEmailPassword] = useState('');
  const [preferences, setPreferences] = useState(null), [grades, setGrades] = useState([]), [loading, setLoading] = useState(user.role === 'professor'), [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' }), [show, setShow] = useState({});
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState({}), [blocked, setBlocked] = useState({}), [remote, setRemote] = useState({});
  const lock = useRef(false), alive = useRef(true);
  const dataDirty = form.name !== saved.name || form.email !== saved.email;
  const normalizedEmail = form.email.trim().toLowerCase();
  const emailChanged = normalizedEmail !== saved.email.trim().toLowerCase();
  const gradesDirty = preferences && !sameIds(grades, preferences.selectedGradeIds);
  const passwordDirty = Object.values(password).some(Boolean);
  useAccountLeave(dataDirty || gradesDirty || passwordDirty, () => lock.current);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const tell = (key, text, kind = 'error') => setNotice(n => ({ ...n, [key]: { text, kind } }));
  useEffect(() => {
    if (user.role !== 'professor') return;
    const controller = new AbortController(); setLoading(true);
    api.get('/auth/grade-preferences', { signal: controller.signal, timeout: 15000 }).then(({ data }) => {
      const p = parsePreferences(data); if (controller.signal.aborted) return;
      setPreferences(p); setGrades(p.selectedGradeIds); tell('grades', '', 'success');
    }).catch(e => { if (!controller.signal.aborted) tell('grades', requestError(e, 'Não foi possível carregar seus anos escolares. Tente novamente.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user.id, user.role, attempt]);
  async function write(key, action) {
    if (lock.current || blocked[key] || blocked.password) return;
    lock.current = true; setBusy(key); tell(key, '');
    try { await action(); }
    catch (e) {
      if (!alive.current) return;
      const uncertain = uncertainWrite(e), conflict = key === 'grades' && e.response?.status === 409;
      if (uncertain || conflict) setBlocked(b => ({ ...b, [key]: true }));
      if (key === 'password' && uncertain) { setPassword({ current: '', next: '', confirm: '' }); setShow({}); }
      tell(key, uncertain ? key === 'password' ? 'Não foi possível confirmar a troca de senha. Entre novamente antes de fazer outra alteração.' : 'Não foi possível confirmar o salvamento. Sua edição continua aqui. Confira os dados salvos antes de tentar novamente.'
        : conflict ? 'Os anos foram alterados em outro acesso. Sua escolha foi mantida. Confira e compare antes de continuar.' : requestError(e, 'Não foi possível salvar. Confira os campos e tente novamente.'));
    } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const validSession = token => { if (!alive.current || !token || authStorage.token() !== token) throw Error('Sessão alterada.'); };
  async function saveData(e) {
    e.preventDefault(); if (!form.name.trim() || !form.email.trim()) return tell('data', 'Preencha nome e e-mail.');
    const expectedEmail = emailChanged ? normalizedEmail : saved.email;
    const payload = { name: form.name.trim(), ...(emailChanged ? { email: expectedEmail, currentPassword: emailPassword } : {}) };
    const token = authStorage.token();
    await write('data', async () => {
      setEmailPassword('');
      const { data } = await api.put('/auth/profile', payload, { timeout: 20000 }); validSession(token);
      const next = parseAccount(data, user); if (next.name !== payload.name || next.email !== expectedEmail) throw Error('Dados não confirmados.');
      setUser(next); setSaved(next); setForm({ name: next.name, email: next.email }); tell('data', 'Dados da conta salvos.', 'success');
    });
  }
  async function saveGrades(e) {
    e.preventDefault(); if (!preferences || loading) return;
    const selected = [...grades], revision = preferences.revision, token = authStorage.token();
    await write('grades', async () => {
      const { data } = await api.put('/auth/grade-preferences', { gradeIds: selected, revision }, { timeout: 20000 }); validSession(token);
      const next = parsePreferences(data); if (!sameIds(next.selectedGradeIds, selected) || next.revision <= revision) throw Error('Preferências não confirmadas.');
      setPreferences(next); setGrades(next.selectedGradeIds); tell('grades', 'Anos escolares salvos.', 'success');
    });
  }
  async function savePassword(e) {
    e.preventDefault();
    if (password.next !== password.confirm) return tell('password', 'As novas senhas não coincidem. Confira os dois campos.');
    const token = authStorage.token();
    await write('password', async () => {
      const { data } = await api.put('/auth/change-password', { currentPassword: password.current, newPassword: password.next }, { timeout: 30000 }); validSession(token);
      const next = parsePasswordChange(data); if (!replaceSessionToken(next, token)) throw Error('Sessão não confirmada.');
      setPassword({ current: '', next: '', confirm: '' }); setShow({}); tell('password', 'Senha alterada. Outros acessos precisarão entrar novamente.', 'success');
    });
  }
  async function check(key) {
    if (lock.current) return; lock.current = true; setBusy(key);
    const token = authStorage.token();
    try {
      const { data } = await api.get(key === 'data' ? '/auth/me' : '/auth/grade-preferences', { timeout: 15000 }); validSession(token);
      setRemote(r => ({ ...r, [key]: key === 'data' ? parseAccount(data, user) : parsePreferences(data) }));
      tell(key, 'Dados conferidos. Compare com sua edição e escolha como continuar.');
    } catch { if (alive.current) tell(key, 'Não foi possível conferir os dados salvos. Sua edição foi mantida.'); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  function resolve(key, keep) {
    if (lock.current || !remote[key]) return;
    if (!window.confirm(keep ? 'Manter sua edição para revisar e salvar novamente? Nada será enviado agora.' : 'Descartar sua edição e usar os dados salvos?')) return;
    const next = remote[key];
    if (key === 'data') { setUser(next); setSaved(next); setEmailPassword(''); if (!keep) setForm({ name: next.name, email: next.email }); }
    else { setPreferences(next); setGrades(keep ? grades.filter(id => next.grades.some(g => g.id === id)) : next.selectedGradeIds); }
    setBlocked(b => ({ ...b, [key]: false })); setRemote(r => ({ ...r, [key]: null })); tell(key, keep ? 'Edição mantida. Revise e salve quando estiver pronta.' : 'Dados salvos carregados.', 'success');
  }
  const disabled = key => Boolean(busy || blocked[key] || blocked.password);
  function recovery(key) {
    return blocked[key] && key !== 'password' && <div className="space-y-2">
      <button type="button" className="btn-outline" disabled={Boolean(busy)} onClick={() => check(key)}>Conferir dados salvos</button>
      {remote[key] && <section className="rounded-lg border border-slate-300 p-3 dark:border-white/20"><h3 className="font-bold">O que está salvo</h3>
        <p className="my-2 text-sm">{key === 'data' ? remote.data.name + ' · ' + remote.data.email : remote.grades.selectedGradeIds.length ? remote.grades.grades.filter(g => remote.grades.selectedGradeIds.includes(g.id)).map(g => g.name).join(', ') : 'Todos os anos'}</p>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn-outline" disabled={Boolean(busy)} onClick={() => resolve(key, true)}>Manter minha edição</button><button type="button" className="btn-outline" disabled={Boolean(busy)} onClick={() => resolve(key, false)}>Usar dados salvos</button></div>
      </section>}
    </div>;
  }
  return <div data-account-workspace className="account-workspace mx-auto max-w-3xl space-y-3 px-3 pb-8 pt-3">
    <header><h1 className="text-xl font-bold">Minha conta</h1><p className="mt-1 text-sm">{user.role === 'admin' ? 'Administrador' : 'Professor(a)'} · Seus dados, preferências e senha.</p></header>
    <nav aria-label="Áreas da conta" className={'grid gap-2 ' + (user.role === 'professor' ? 'grid-cols-3' : 'grid-cols-2')}>
      {[['data', 'Dados'], ...(user.role === 'professor' ? [['grades', 'Anos escolares']] : []), ['password', 'Senha']].map(([key, label]) => <button type="button" key={key} aria-pressed={area === key} onClick={() => { setArea(key); if (key !== 'data') setEmailPassword(''); }} className={area === key ? 'btn-primary' : 'btn-outline'}>{label}{(key === 'data' ? dataDirty : key === 'grades' ? gradesDirty : passwordDirty) && <span aria-label="alterações não salvas">*</span>}</button>)}
    </nav>
    {blocked.password && <div className="space-y-2"><AccountNotice focus={area === 'password' || Boolean(blocked.password)} value={notice.password} /><button type="button" className="btn-outline" disabled={Boolean(busy)} onClick={async () => { if (!window.confirm('Sair para entrar novamente? Alterações não salvas serão descartadas.')) return; try { await logout(); } catch { tell('password', 'Não foi possível encerrar a sessão. Tente sair novamente.'); } }}>Sair para entrar novamente</button></div>}
    <section hidden={area !== 'data'} className={accountPanel}>
      <h2 className="mb-3 font-bold">Dados de acesso</h2>
      <form onSubmit={saveData} className="space-y-3"><fieldset disabled={disabled('data')} className="space-y-3">
        <label className="block text-sm font-semibold">Nome<input autoComplete="name" className="input mt-1" required maxLength={100} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
        <label className="block text-sm font-semibold">E-mail<input autoComplete="email" className="input mt-1" required maxLength={254} type="email" value={form.email} onChange={e => { setEmailPassword(''); setForm(f => ({ ...f, email: e.target.value })); }} /></label>
        <p className="text-sm">Use este e-mail para entrar e recuperar o acesso.</p>
        {emailChanged && <label className="block text-sm font-semibold">Senha atual para alterar o e-mail
          <input autoComplete="current-password" className="input mt-1" required maxLength={1024} type="password" value={emailPassword} onChange={e => setEmailPassword(e.target.value)} />
        </label>}
        <div className="flex flex-wrap gap-2"><button type="submit" className="btn-primary" disabled={!dataDirty}>{busy === 'data' ? 'Salvando...' : 'Salvar dados'}</button><button type="button" className="btn-outline" disabled={!dataDirty} onClick={() => { if (window.confirm('Descartar as alterações de nome e e-mail?')) { setForm({ name: saved.name, email: saved.email }); setEmailPassword(''); tell('data', ''); } }}>Desfazer</button></div>
      </fieldset><AccountNotice focus={area === 'data'} value={notice.data} />{recovery('data')}</form>
    </section>
    {user.role === 'professor' && <section hidden={area !== 'grades'} className={accountPanel}>
      <h2 className="font-bold">Meus anos escolares</h2><p className="my-2 text-sm">Escolha os anos que deseja encontrar no filtro “Meus anos” da Biblioteca e do Banco de questões.</p>
      {loading ? <p role="status">Carregando anos escolares...</p> : !preferences ? <div className="space-y-3"><AccountNotice focus={area === 'grades'} value={notice.grades} /><button type="button" className="btn-outline" onClick={() => setAttempt(a => a + 1)}>Tentar novamente</button></div> : <form onSubmit={saveGrades} className="space-y-3">
        <fieldset disabled={disabled('grades')}><legend className="sr-only">Anos de interesse</legend><div className="grid gap-2 sm:grid-cols-2">{preferences.grades.map(g => <label key={g.id} className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 p-2 text-sm dark:border-white/10"><input type="checkbox" checked={grades.includes(g.id)} onChange={() => setGrades(ids => ids.includes(g.id) ? ids.filter(i => i !== g.id) : [...ids, g.id])} />{g.name}</label>)}</div>
          <p className="my-3 text-sm">{grades.length ? grades.length + ' ano(s) selecionado(s). Os outros anos continuam disponíveis.' : 'Sem seleção, “Meus anos” mostra todos os anos.'}</p>
          <div className="flex flex-wrap gap-2"><button type="submit" disabled={!gradesDirty} className="btn-primary">{busy === 'grades' ? 'Salvando...' : 'Salvar anos'}</button><button type="button" className="btn-outline" disabled={!gradesDirty} onClick={() => { if (window.confirm('Descartar a seleção ainda não salva?')) setGrades(preferences.selectedGradeIds); }}>Desfazer seleção</button></div>
        </fieldset><AccountNotice focus={area === 'grades'} value={notice.grades} />{recovery('grades')}
      </form>}
    </section>}
    <section hidden={area !== 'password'} className={accountPanel}>
      <h2 className="font-bold">Alterar senha</h2><p className="my-2 text-sm">Use pelo menos 8 caracteres. Outros acessos precisarão entrar novamente.</p>
      <form onSubmit={savePassword} className="space-y-3"><fieldset disabled={disabled('password')} className="space-y-3">
        {[['current', 'Senha atual'], ['next', 'Nova senha'], ['confirm', 'Confirmar nova senha']].map(([key, label]) => <div key={key}><label htmlFor={'account-password-' + key} className="mb-1 block text-sm font-semibold">{label}</label><div className="flex gap-2"><input id={'account-password-' + key} autoComplete={key === 'current' ? 'current-password' : 'new-password'} className="input min-w-0" type={show[key] ? 'text' : 'password'} required minLength={key === 'current' ? 1 : 8} maxLength={1024} value={password[key]} onChange={e => setPassword(p => ({ ...p, [key]: e.target.value }))} /><button type="button" className="btn-outline shrink-0 px-2" aria-label={(show[key] ? 'Ocultar ' : 'Mostrar ') + label.toLowerCase()} aria-pressed={Boolean(show[key])} onClick={() => setShow(s => ({ ...s, [key]: !s[key] }))}>{show[key] ? 'Ocultar' : 'Mostrar'}</button></div></div>)}
        <div className="flex flex-wrap gap-2"><button type="submit" className="btn-primary">{busy === 'password' ? 'Alterando...' : 'Alterar senha'}</button><button type="button" className="btn-outline" disabled={!passwordDirty} onClick={() => { if (window.confirm('Limpar os campos de senha?')) { setPassword({ current: '', next: '', confirm: '' }); setShow({}); tell('password', ''); } }}>Limpar campos</button></div>
      </fieldset>{!blocked.password && <AccountNotice focus={area === 'password' || Boolean(blocked.password)} value={notice.password} />}</form>
    </section>
    {(dataDirty || gradesDirty || passwordDirty) && <p role="status" className="text-sm">* Há alterações não salvas. Trocar de área mantém sua edição nesta tela.</p>}
  </div>;
}
