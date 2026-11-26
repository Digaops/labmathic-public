import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import usePublicWrite from '../hooks/usePublicWrite';
import { PublicNotice } from '../components/PublicAccess';
import { publicError } from '../services/publicAccess.mjs';
import { portraitReturnPath } from '../services/networkPortraitQuery.mjs';
import { ArrowRight, BookOpen, ClipboardList, Eye, EyeOff, Lock, Mail, ShieldCheck, Users } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const write = usePublicWrite();
  const loading = write.busy;
  const { login, sessionNotice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnPath = portraitReturnPath(location.search);

  const handleSubmit = event => {
    event.preventDefault();
    if (loading) return;
    setError('');
    write.run(signal => login(email.trim(), password, remember, { signal }), () => navigate(returnPath, { replace: true }), err => {
      setError(publicError(err, err.isAxiosError ? 'Não foi possível conectar. Confira a conexão e tente novamente.' : err.message || 'Não foi possível entrar. Tente novamente.'));
    });
  };

  return (
    <div className="login-screen min-h-svh bg-[#061B3A] text-white">
      <main className="login-main relative mx-auto flex min-h-svh max-w-[1120px] items-center px-4 py-5 sm:px-6 lg:px-8">
        <div className="login-grid grid w-full items-stretch gap-6 lg:grid-cols-[1fr_1.04fr] lg:gap-10">
          <section className="login-brand-panel relative hidden min-w-0 flex-col justify-between overflow-hidden rounded-3xl border border-cyan-300/20 bg-[#0A254C] p-8 lg:flex" aria-labelledby="login-brand-title">
            <div className="pointer-events-none absolute -right-24 -top-20 h-72 w-72 rounded-full bg-cyan-300/10 blur-3xl" aria-hidden="true" />
            <div className="relative flex items-center gap-3">
              <img src="/logos/logo-labmathic-mark.png" alt="" width="56" height="56" className="h-14 w-14 shrink-0 rounded-2xl bg-white object-contain p-1" />
              <div><p className="text-2xl font-extrabold tracking-tight">Lab<span className="text-cyan-300">Mathic</span></p>
                <p className="mt-0.5 text-xs text-slate-300">Laboratórios Educacionais</p></div>
            </div>
            <div className="relative my-7">
              <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">Ao lado de quem ensina</p>
              <h2 id="login-brand-title" className="login-brand-title text-4xl font-extrabold leading-[1.16] tracking-tight">
                Mais tempo para<br /><span className="text-cyan-300">o que importa.</span>
              </h2>
              <p className="mt-4 max-w-sm text-base leading-relaxed text-slate-200">Materiais, turmas e avaliações em um só lugar, para apoiar cada etapa do seu trabalho.</p>
            </div>
            <ul className="relative space-y-3 text-sm text-slate-200">
              <Benefit icon={BookOpen}>Encontre materiais para suas aulas</Benefit>
              <Benefit icon={ClipboardList}>Prepare questões e avaliações</Benefit>
              <Benefit icon={Users}>Acompanhe a aprendizagem da turma</Benefit>
            </ul>
          </section>

          <section className="login-form-panel mx-auto w-full max-w-[480px] rounded-3xl border border-white/80 bg-white p-5 text-[#0F172A] shadow-2xl shadow-black/20 sm:p-8 lg:max-w-none" aria-labelledby="login-title">
            <div className="mb-5 flex items-center gap-2.5 lg:hidden">
              <img src="/logos/logo-labmathic-mark.png" alt="" width="36" height="36" className="h-9 w-9 object-contain" />
              <span className="text-xl font-extrabold tracking-tight text-[#0F172A]">Lab<span className="text-[#1D4ED8]">Mathic</span></span>
            </div>
            <p className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#1D4ED8]">Acesso à plataforma</p>
            <h1 id="login-title" className="text-2xl font-extrabold tracking-tight text-[#0F172A] sm:text-3xl">Bem-vindo de volta</h1>
            <p className="mt-2 text-sm leading-relaxed text-[#64748B]">Entre com sua conta de professor ou da administração.</p>
            {returnPath !== '/' && <p className="mt-3 text-sm leading-relaxed text-[#1D4ED8]">Após entrar, vamos abrir a consulta do Retrato da rede. O acesso continua dependendo da liberação da sua conta.</p>}

            {sessionNotice && !error && <p role="status" className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-[#1D4ED8]">{sessionNotice}</p>}
            <PublicNotice id="login-error" text={error} />

            <form onSubmit={handleSubmit} className="mt-5 space-y-4" aria-busy={loading} aria-describedby={error ? 'login-error' : undefined}>
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-semibold text-[#0F172A]">E-mail</label>
                <div className="relative">
                  <Mail size={19} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#64748B]" aria-hidden="true" />
                  <input id="email" name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false}
                    className="login-input h-12 w-full rounded-xl border border-slate-300 bg-white pl-11 pr-3 text-base text-[#0F172A] outline-none transition-shadow placeholder:text-slate-500 focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15 disabled:opacity-70"
                    maxLength={254} placeholder="Seu e-mail cadastrado" value={email} onChange={event => setEmail(event.target.value)} required disabled={loading} />
                </div>
              </div>
              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-semibold text-[#0F172A]">Senha</label>
                <div className="relative">
                  <Lock size={19} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#64748B]" aria-hidden="true" />
                  <input id="password" name="password" type={showPass ? 'text' : 'password'} autoComplete="current-password"
                    className="login-input h-12 w-full rounded-xl border border-slate-300 bg-white pl-11 pr-12 text-base text-[#0F172A] outline-none transition-shadow placeholder:text-slate-500 focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15 disabled:opacity-70"
                    maxLength={1024} placeholder="Sua senha" value={password} onChange={event => setPassword(event.target.value)} required disabled={loading} />
                  <button type="button" onClick={() => setShowPass(value => !value)} disabled={loading}
                    className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-[#64748B] hover:text-[#1D4ED8]"
                    aria-label={showPass ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPass}>
                    {showPass ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>
              <div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium text-[#0F172A]">
                    <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={loading}
                      aria-describedby="remember-help" className="h-4 w-4 rounded border-slate-300 accent-blue-700" />
                    Lembrar-me
                  </label>
                  <Link to="/esqueci-senha" className="inline-flex min-h-8 items-center text-sm font-semibold text-[#1D4ED8] underline-offset-4 hover:underline">Esqueceu a senha?</Link>
                </div>
                <p id="remember-help" className="mt-1 text-xs leading-5 text-[#64748B]">
                  {remember ? 'Acesso lembrado neste navegador por até 24 horas. Use apenas em dispositivo pessoal.' : 'Sessão desta aba. Em computador compartilhado, use Sair ao terminar.'}
                </p>
              </div>
              <button type="submit" disabled={loading}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-4 py-3 text-base font-bold text-white shadow-md shadow-blue-900/15 transition-colors hover:bg-[#1E40AF] disabled:cursor-wait disabled:opacity-70">
                {loading ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" aria-hidden="true" />Entrando...</>
                  : <>Entrar no sistema<ArrowRight size={19} aria-hidden="true" /></>}
              </button>
            </form>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 text-xs text-[#64748B]">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck size={16} aria-hidden="true" />Acesso individual</span>
              <nav aria-label="Informações de acesso" className="flex gap-4">
                <Link to="/privacidade" className="hover:text-[#1D4ED8] hover:underline">Privacidade</Link>
                <Link to="/termos-de-uso" className="hover:text-[#1D4ED8] hover:underline">Termos de uso</Link>
              </nav>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function Benefit({ icon: Icon, children }) {
  return <li className="flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-300/10 text-cyan-300"><Icon size={17} aria-hidden="true" /></span>{children}</li>;
}
