import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Users, MessageCircle, Plus, FileText, FolderOpen, BarChart3, History, ArrowRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import useHomeResource from '../../hooks/useHomeResource';
import { adminAttention, adminMaterialStats, adminTopContent } from '../../services/adminDashboardView.mjs';

const panel = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const action = 'inline-flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-cyan-200 dark:hover:bg-white/5';
const number = value => value.toLocaleString('pt-BR');

export default function AdminDashboard() {
  const { user, announcementAccessId } = useAuth();
  // The route guard remains in place; this key also discards views on account changes.
  const identity = user?.id + ':' + announcementAccessId;
  return user?.role === 'admin' ? <AdministrativePanel key={identity} identity={identity} /> : null;
}
function AdministrativePanel({ identity }) {
  const [showNumbers, setShowNumbers] = useState(false);
  const flags = useFeatureFlags();
  const attention = useHomeResource('/reports/overview', identity, adminAttention);
  return <div data-admin-dashboard className="mx-auto max-w-6xl space-y-4 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header><h1 className="text-2xl font-bold tracking-tight">Painel administrativo</h1><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Escolha o que precisa organizar. Os números do acervo ficam abaixo.</p></header>
    <div className="grid gap-4 md:grid-cols-2">
      <section className={panel + ' p-3 sm:p-4'} aria-labelledby="admin-people-title">
        <h2 id="admin-people-title" className="mb-1 px-2 text-base font-bold">Escolas e pessoas</h2>
        <nav aria-label="Escolas e pessoas"><ul className="divide-y divide-slate-100 dark:divide-white/10">
          {flags.isEnabled('institutions.read_model') ? <Task to="/instituicoes" icon={Building2} title="Organizar instituições" text="Municípios, escolas, profissionais e turmas." />
            : <li className="px-2 py-3 text-sm text-slate-600 dark:text-slate-300">{flags.loading ? 'Conferindo acesso às instituições…' : flags.unavailable ? 'Não foi possível conferir o acesso às instituições.' : 'A organização de instituições não está liberada nesta conta.'}</li>}
          <Task to="/admin/usuarios" icon={Users} title="Gerenciar usuários" text="Contas de acesso e perfis do sistema." />
          <Task to="/fale-conosco" icon={MessageCircle} title="Responder professores" text="Dúvidas e pedidos enviados pelo Fale Conosco." />
          {flags.isEnabled('content.issue_review') && <Task to="/problemas-no-acervo" icon={MessageCircle} title="Revisar problemas no acervo" text="Conferir questões e materiais e responder aos relatos." />}
        </ul></nav>
        <div data-admin-attention className="mt-2 border-t border-slate-200 px-2 pt-2 dark:border-white/10">
          <div className="flex flex-wrap items-center justify-between gap-1"><h3 className="text-sm font-semibold">Atendimento</h3><button type="button" className={action} disabled={attention.status === 'loading'} onClick={attention.retry}>Atualizar atendimento</button></div>
          <ReadState resource={attention} error="Não foi possível consultar as mensagens não lidas. Atualize o atendimento para tentar novamente." />
          {attention.status === 'ready' && <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">{attention.data.unread > 0 ? number(attention.data.unread) + (attention.data.unread === 1 ? ' mensagem não lida' : ' mensagens não lidas') + ' no Fale Conosco.' : 'Nenhuma mensagem não lida no Fale Conosco.'}</p>}
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">Mensagem lida não significa que o pedido já foi resolvido.</p>
        </div>
      </section>
      <section className={panel + ' p-3 sm:p-4'} aria-labelledby="admin-resources-title">
        <h2 id="admin-resources-title" className="mb-1 px-2 text-base font-bold">Acervo e registros</h2>
        <nav aria-label="Acervo e registros"><ul className="divide-y divide-slate-100 dark:divide-white/10">
          <Task to="/admin/materiais/novo" icon={Plus} title="Novo material" text="Adicionar um recurso à biblioteca." />
          <Task to="/admin/materiais" icon={FileText} title="Gerenciar materiais" text="Encontrar e revisar os materiais cadastrados." />
          {flags.isEnabled('question_bank.numeric_drafts') && <Task to="/admin/questoes-numericas/revisoes" icon={FileText} title="Revisar questões numéricas" text="Aprovar os envios dos professores ou orientar ajustes." />}
          <Task to="/admin/categorias" icon={FolderOpen} title="Gerenciar categorias" text="Organizar disciplinas, anos, tipos e tópicos." />
          <Task to="/admin/relatorios" icon={BarChart3} title="Consultar relatórios" text="Ver os registros de uso da plataforma." />
          <Task to="/admin/atividades" icon={History} title="Histórico de ações" text="Conferir quem fez o quê e quando." />
        </ul></nav>
      </section>
    </div>
    <details className={panel} onToggle={event => setShowNumbers(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer rounded-2xl px-4 py-3 text-sm font-bold">Consultar números do acervo</summary>
      {showNumbers && <div className="space-y-4 border-t border-slate-200 p-3 sm:p-4 dark:border-white/10">
        <p className="text-sm text-slate-600 dark:text-slate-300">Contagens da consulta atual. Acessos não medem aprendizagem nem avaliam o trabalho do professor.</p>
        <div className="grid items-start gap-4 lg:grid-cols-2"><MaterialNumbers identity={identity} /><PopularContent identity={identity} /></div>
      </div>}
    </details>
  </div>;
}
function Task({ to, icon: Icon, title, text }) {
  return <li><Link to={to} className="group flex min-h-11 items-center gap-3 rounded-xl px-2 py-3 hover:bg-slate-50 dark:hover:bg-white/5">
    <Icon size={20} className="shrink-0 text-blue-700 dark:text-cyan-200" aria-hidden="true" />
    <span className="min-w-0 flex-1"><span className="block text-sm font-bold">{title}</span><span className="mt-1 block text-sm leading-5 text-slate-600 dark:text-slate-300">{text}</span></span>
    <ArrowRight size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
  </Link></li>;
}
function ReadState({ resource, error }) {
  return <>{resource.status === 'loading' && <p role="status" className="py-2 text-sm text-slate-600 dark:text-slate-300">Consultando…</p>}
    {resource.status === 'error' && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">{error}</p>}</>;
}
function QueryHeader({ title, label, resource }) {
  return <div className="mb-2 flex flex-wrap items-center justify-between gap-1"><h2 className="text-base font-bold">{title}</h2><button type="button" className={action} disabled={resource.status === 'loading'} onClick={resource.retry}>{label}</button></div>;
}
function MaterialNumbers({ identity }) {
  const resource = useHomeResource('/materials/stats', identity, adminMaterialStats), stats = resource.data;
  return <section data-admin-numbers className={panel + ' p-3'}>
    <QueryHeader title="Resumo do acervo" label="Atualizar acervo" resource={resource} />
    <ReadState resource={resource} error="Não foi possível consultar os números do acervo. Tente atualizar esta seção." />
    {resource.status === 'ready' && <>
      <dl className="divide-y divide-slate-100 text-sm dark:divide-white/10">{[['Materiais cadastrados', stats.total], ['Incluídos neste mês', stats.thisMonth], ['Tipos com materiais', stats.usedTypes]].map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-2"><dt>{label}</dt><dd className="font-bold tabular-nums">{number(value)}</dd></div>)}</dl>
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">O mês segue o calendário do servidor.</p>
      <h3 className="mb-2 mt-4 text-sm font-bold">Distribuição por tipo</h3>
      {!stats.total ? <p className="text-sm text-slate-600 dark:text-slate-300">Ainda não há materiais cadastrados.</p> : <ul className="space-y-3">{[...stats.byType, ...(stats.unassigned ? [{ name: 'Sem tipo informado', count: stats.unassigned }] : [])].map((type, i) => {
        const percent = Math.round(type.count * 100 / stats.total);
        return <li key={i}><div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm"><span>{type.name}</span><span className="text-slate-600 dark:text-slate-300">{number(type.count)} · {percent}%</span></div><div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10"><div className="h-full rounded-full bg-blue-600 dark:bg-cyan-300" style={{ width: percent + '%' }} /></div></li>;
      })}</ul>}
    </>}
  </section>;
}
function PopularContent({ identity }) {
  const resource = useHomeResource('/reports/top-content?limit=5', identity, adminTopContent);
  return <section data-admin-popular className={panel + ' p-3'}>
    <QueryHeader title="Conteúdos mais consultados" label="Atualizar conteúdos" resource={resource} />
    <p className="mb-2 text-xs leading-5 text-slate-500 dark:text-slate-400">Até cinco materiais ou simulados com acessos registrados, considerando todo o histórico disponível.</p>
    <ReadState resource={resource} error="Não foi possível consultar os conteúdos. Tente atualizar esta seção." />
    {resource.status === 'ready' && (resource.data.length ? <ul className="divide-y divide-slate-100 dark:divide-white/10">{resource.data.map(item => <li key={item.key}><Link to={item.path} className="block min-h-11 rounded-lg px-2 py-3 hover:bg-slate-50 dark:hover:bg-white/5">
      <span className="block text-sm font-semibold">{item.title}</span><span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">{item.content_type === 'material' ? 'Material' : 'Simulado'}{item.category ? ' · ' + item.category : ''}</span>
      <span className="mt-1 block text-sm font-semibold text-blue-700 dark:text-cyan-200">{number(item.access_count)} {item.access_count === 1 ? 'acesso' : 'acessos'} · Abrir conteúdo</span>
    </Link></li>)}</ul> : <p className="py-2 text-sm text-slate-600 dark:text-slate-300">Ainda não há acessos registrados aos materiais e simulados.</p>)}
  </section>;
}
