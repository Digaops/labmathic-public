import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { institutionalHomeLinks } from '../services/dashboardHome.mjs';

const workspace = 'editorial-workspace mx-auto max-w-5xl space-y-4 px-4 py-4 sm:px-6';
const muted = 'text-sm leading-6 text-slate-600 dark:text-slate-300';
const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300';
const link = `inline-flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-cyan-800 hover:bg-cyan-50 dark:text-cyan-200 dark:hover:bg-white/5 ${focus}`;
const scopeText = {
  municipality: 'Você acompanha os municípios vinculados à sua conta.',
  school: 'Você acompanha as escolas vinculadas à sua conta.',
  mixed: 'Você acompanha municípios e escolas vinculados à sua conta.',
};

export default function InstitutionalHome({ model, features, error, refreshing, onRefresh }) {
  const { network, personal } = institutionalHomeLinks(features);
  return <div data-institutional-home className={workspace}>
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h1 data-testid="dashboard-heading" className="text-xl font-bold tracking-tight sm:text-2xl">Minha rede</h1>
        <p className={`mt-1 ${muted}`}>{scopeText[model.scopeLevel]}</p>
      </div>
      <button type="button" className={`${link} disabled:opacity-60`} disabled={refreshing} onClick={onRefresh}>Atualizar</button>
    </header>
    {error && <p role="alert" className="text-sm leading-6 text-amber-900 dark:text-amber-200">Não foi possível atualizar as informações da rede. Mantivemos a última consulta confirmada. Use “Atualizar” para tentar novamente.</p>}
    {refreshing && <p role="status" className={muted}>Atualizando as informações da rede. Os acessos confirmados continuam disponíveis.</p>}
    <nav aria-label="Trabalho na rede">
      <ul className="divide-y divide-slate-200 dark:divide-white/10">
        {network.map(item => <li key={item.to}>
          <Link to={item.to} className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-3 hover:bg-slate-100 dark:hover:bg-white/5 ${focus}`}>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-base font-semibold text-cyan-800 dark:text-cyan-200">{item.label}</span>
              <span className={`mt-1 block break-words ${muted}`}>{item.description}</span>
            </span>
            <ArrowRight size={18} className="shrink-0 text-cyan-700 dark:text-cyan-300" aria-hidden="true" />
          </Link>
        </li>)}
      </ul>
    </nav>
    <details className="border-t border-slate-200 pt-2 dark:border-white/10">
      <summary className={`min-h-11 cursor-pointer rounded-xl px-3 py-3 text-sm font-semibold ${focus}`}>Recursos e trabalho pessoal</summary>
      <p className={`px-3 ${muted}`}>Se você também prepara aulas, seus recursos e ferramentas pessoais continuam disponíveis.</p>
      <nav aria-label="Recursos e trabalho pessoal" className="mt-2 flex flex-wrap gap-1">
        {personal.map(item => <Link key={item.to} to={item.to} className={link}>{item.label}</Link>)}
      </nav>
    </details>
    <Link to="/fale-conosco" className={link}>Pedir ajuda</Link>
  </div>;
}

export function HomeContextStatus({ state, onRetry }) {
  const loading = state === 'loading';
  return <div data-home-context-status className={workspace}>
    <h1 data-testid="dashboard-heading" className="text-xl font-bold sm:text-2xl">Início</h1>
    <p role={loading ? 'status' : 'alert'} className={muted}>{loading
      ? 'Conferindo suas áreas de trabalho…'
      : 'Não foi possível confirmar suas áreas de trabalho. Tente novamente.'}</p>
    {!loading && <button type="button" className="btn-outline" onClick={onRetry}>Tentar novamente</button>}
  </div>;
}
