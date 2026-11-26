import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Building2, Settings, Users, MessageCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import useHomeResource from '../hooks/useHomeResource';
import { adminHistory, adminFavorites, adminRecentMaterials, adminRecentSets, adminHomeStats, adminNetworkSummary } from '../services/adminHomeView.mjs';

const surface = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const secondary = 'inline-flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-cyan-200 dark:hover:bg-white/5';
const body = 'text-sm leading-6 text-slate-600 dark:text-slate-300';
const number = value => value.toLocaleString('pt-BR');

export default function AdministrativeHome() {
  const { user, announcementAccessId } = useAuth();
  const identity = `${user?.id}:${announcementAccessId}`;
  return user?.role === 'admin' ? <Home key={identity} identity={identity} /> : null;
}
function Home({ identity }) {
  const flags = useFeatureFlags();
  const network = flags.isEnabled('institutions.read_model');
  const examples = [['question_bank.catalog_preview', '/exemplos/banco-questoes', 'Exemplos do Banco 2.0'],
    ['question_bank.feedback_preview', '/exemplos/devolutivas', 'Exemplos de devolutivas'],
    ['question_bank.typed_preview', '/exemplos/formatos', 'Exemplos de formatos']].filter(([flag]) => flags.isEnabled(flag));
  return <div data-admin-home className="mx-auto max-w-6xl space-y-4 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header><h1 data-testid="dashboard-heading" className="text-2xl font-bold tracking-tight">Início da administração</h1><p className={body + ' mt-1'}>Escolha uma tarefa para começar.</p></header>
    <nav aria-label="Tarefas da administração" className={surface + ' grid p-2 md:grid-cols-2'}>
      <Task to="/admin" icon={Settings} title="Abrir administração" text="Materiais, categorias, relatórios e histórico." />
      {network ? <Task to="/instituicoes" icon={Building2} title="Organizar instituições" text="Municípios, escolas, profissionais e turmas." />
        : <p className={body + ' px-3 py-3'}>{flags.loading ? 'Conferindo acesso às instituições…' : flags.unavailable ? 'Não foi possível conferir o acesso às instituições.' : 'A organização de instituições não está liberada nesta conta.'}</p>}
      <Task to="/admin/usuarios" icon={Users} title="Gerenciar usuários" text="Contas de acesso e perfis do sistema." />
      <Task to="/fale-conosco" icon={MessageCircle} title="Responder professores" text="Dúvidas e pedidos no Fale Conosco." />
      {flags.isEnabled('question_bank.numeric_drafts') && <Task to="/admin/questoes-numericas/revisoes" icon={MessageCircle} title="Revisar questões numéricas" text="Conferir os envios e responder aos professores." />}
      {flags.isEnabled('content.issue_review') && <Task to="/problemas-no-acervo" icon={MessageCircle} title="Revisar problemas no acervo" text="Relatos sobre questões e materiais, com resposta ao professor." />}
    </nav>
    <nav aria-label="Outros acessos" className="flex flex-wrap gap-1">
      {[['/admin/materiais', 'Gerenciar materiais'], ['/admin/relatorios', 'Ver relatórios'], ['/biblioteca', 'Abrir biblioteca'], ['/banco-questoes', 'Banco de questões'], ['/simulados', 'Ver simulados']].map(([to, text]) => <Link key={to} to={to} className={secondary}>{text}</Link>)}
    </nav>
    {network && <Optional title="Consultar resumo da rede"><NetworkSummary identity={identity} /></Optional>}
    <Optional title="Retomar materiais e favoritos"><div className="grid items-start gap-4 lg:grid-cols-2">
      <ResourceList identity={identity} name="history" title="Materiais que consultei" description="Até quatro materiais acessados por esta conta." url="/materials/history?limit=4" parse={adminHistory} empty="Esta conta ainda não consultou materiais." action="Atualizar histórico" to="/biblioteca" link="Ver biblioteca" />
      <ResourceList identity={identity} name="favorites" title="Meus favoritos" description="Até três favoritos mais recentes desta conta." url="/favorites?limit=3" parse={adminFavorites} empty="Esta conta ainda não tem materiais favoritos." action="Atualizar favoritos" to="/favoritos" link="Ver todos os favoritos" />
    </div></Optional>
    <Optional title="Consultar acervo e simulados"><div className="space-y-4">
      <CatalogSummary identity={identity} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ResourceList identity={identity} name="materials" title="Materiais recentes" description="Até seis materiais adicionados à biblioteca." url="/materials?limit=6&sort=recent" parse={adminRecentMaterials} empty="Ainda não há materiais no acervo. Use Gerenciar materiais para cadastrar." action="Atualizar materiais" to="/biblioteca" link="Ver todos os materiais" />
        <ResourceList identity={identity} name="sets" title="Simulados recentes" description="Até três simulados da plataforma, inclusive os privados disponíveis à administração." url="/question-bank/question-sets?limit=3&all=1" parse={adminRecentSets} empty="Ainda não há simulados cadastrados." action="Atualizar simulados" to="/simulados" link="Ver todos os simulados" />
      </div>
    </div></Optional>
    {examples.length > 0 && <Optional title="Conhecer os exemplos"><p className={body}>Demonstrações para conhecer formatos e devolutivas. Não são diagnósticos ou intervenções de uma turma real.</p><nav aria-label="Exemplos demonstrativos" className="mt-2 flex flex-col items-start gap-1">{examples.map(([flag, to, text]) => <Link key={flag} to={to} className={secondary}>{text}<ArrowRight size={16} className="ml-2 shrink-0" aria-hidden="true" /></Link>)}</nav></Optional>}
  </div>;
}
function Task({ to, icon: Icon, title, text }) {
  return <Link to={to} className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-3 hover:bg-slate-50 dark:hover:bg-white/5"><Icon size={20} className="shrink-0 text-blue-700 dark:text-cyan-200" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block text-sm font-bold">{title}</span><span className="mt-1 block text-sm leading-5 text-slate-600 dark:text-slate-300">{text}</span></span><ArrowRight size={16} className="shrink-0 text-slate-400" aria-hidden="true" /></Link>;
}
function Optional({ title, children }) {
  const [open, setOpen] = useState(false);
  return <details className={surface} onToggle={event => setOpen(event.currentTarget.open)}><summary className="min-h-11 cursor-pointer rounded-2xl px-4 py-3 text-sm font-bold">{title}</summary>{open && <div className="border-t border-slate-200 p-3 sm:p-4 dark:border-white/10">{children}</div>}</details>;
}
function ResourceHeader({ title, action, resource }) {
  return <div className="mb-1 flex flex-wrap items-center justify-between gap-1"><h2 className="text-base font-bold">{title}</h2><button type="button" className={secondary} disabled={resource.status === 'loading'} onClick={resource.retry}>{action}</button></div>;
}
function ReadState({ resource, title, action }) {
  return <>{resource.status === 'loading' && <p role="status" className={body + ' py-2'}>Consultando…</p>}{resource.status === 'error' && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">Não foi possível consultar {title}. Use “{action}” para tentar novamente.</p>}</>;
}
function ResourceList({ identity, name, title, description, url, parse, empty, action, to, link }) {
  const resource = useHomeResource(url, identity, parse);
  return <section data-admin-home-list={name} className={surface + ' p-3'}>
    <ResourceHeader title={title} action={action} resource={resource} /><p className={body + ' mb-2'}>{description}</p><ReadState resource={resource} title="esta lista" action={action} />
    {resource.status === 'ready' && (resource.data.length ? <ul className="divide-y divide-slate-100 dark:divide-white/10">{resource.data.map(item => <li key={item.id}><Link to={item.path} className="block min-h-11 rounded-lg px-2 py-3 hover:bg-slate-50 dark:hover:bg-white/5"><span className="block text-sm font-semibold">{item.title}</span>{item.discipline && <span className={body + ' block'}>{item.discipline}</span>}<span className="mt-1 block text-sm text-blue-700 dark:text-cyan-200">{item.questionCount === null ? 'Abrir material' : `${number(item.questionCount)} ${item.questionCount === 1 ? 'questão' : 'questões'} · Abrir simulado`}</span></Link></li>)}</ul> : <p className={body + ' py-2'}>{empty}</p>)}
    <Link className={secondary + ' mt-2'} to={to}>{link}<ArrowRight size={16} className="ml-2 shrink-0" aria-hidden="true" /></Link>
  </section>;
}
function CatalogSummary({ identity }) {
  const resource = useHomeResource('/materials/dashboard-stats', identity, adminHomeStats);
  const labels = [['totalMaterials', 'Materiais', '/biblioteca'], ['totalQuestions', 'Questões', '/banco-questoes'], ['totalQuestionSets', 'Simulados', '/simulados'], ['totalCoveredSkills', 'Habilidades BNCC com questões', '/banco-questoes']];
  return <section data-admin-home-stats className={surface + ' p-3'}><ResourceHeader title="Totais da plataforma" action="Atualizar totais" resource={resource} /><p className={body + ' mb-2'}>Contagens gerais do acervo, não apenas desta conta. Elas não medem a aprendizagem dos estudantes.</p><ReadState resource={resource} title="os totais" action="Atualizar totais" />{resource.status === 'ready' && <dl className="grid gap-x-4 sm:grid-cols-2">{labels.map(([key, text, to]) => <div key={key} className="flex items-center justify-between gap-3 border-t border-slate-100 dark:border-white/10"><dt><Link to={to} className={secondary + ' justify-start px-0'}>{text}</Link></dt><dd className="text-sm font-bold tabular-nums">{number(resource.data[key])}</dd></div>)}</dl>}</section>;
}
function NetworkSummary({ identity }) {
  const resource = useHomeResource('/institutions/read-model', identity, adminNetworkSummary);
  return <section data-admin-home-network><ResourceHeader title="Escolas e turmas da rede" action="Atualizar rede" resource={resource} /><ReadState resource={resource} title="o resumo da rede" action="Atualizar rede" />{resource.status === 'ready' && <>
    <dl className="grid gap-x-4 sm:grid-cols-2">{[['activeMunicipalities', 'Municípios ativos'], ['activeSchools', 'Escolas ativas'], ['verifiedClasses', 'Turmas com escola confirmada'], ['pendingClasses', 'Turmas com vínculo pendente']].map(([key, text]) => <div key={key} className="flex justify-between gap-3 border-t border-slate-100 py-2 text-sm dark:border-white/10"><dt>{text}</dt><dd className="font-bold tabular-nums">{number(resource.data[key])}</dd></div>)}</dl><p className={body + ' mt-2'}>A situação do vínculo não impede o trabalho pedagógico da turma. Confira os detalhes antes de fazer alterações.</p>
    </>}<Link to="/instituicoes" className={secondary + ' mt-2'}>Abrir instituições<ArrowRight size={16} className="ml-2 shrink-0" aria-hidden="true" /></Link></section>;
}
