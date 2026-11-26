import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, CalendarDays, ChevronDown, ClipboardList, FlaskConical,
  Heart, HeartPulse, History, LoaderCircle, MessageCircle, RefreshCw, School, Search, UsersRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import useHomeResource from '../hooks/useHomeResource';
import { operationalBankState } from '../services/bankExperiences.mjs';
import { recoveryWorkspaceState } from '../services/recoveryPlansView.mjs';
import { classHomePath, homeAttention, homeClasses, homeDate, homeList, homeOverview, homePlans, recentHomeWork } from '../services/teacherHome.mjs';
import { pluralize } from '../utils/pluralize';

const surface = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300';
const linkStyle = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold text-cyan-800 transition hover:bg-cyan-50 dark:text-cyan-200 dark:hover:bg-white/5 ${focus}`;
const rowStyle = `group flex min-w-0 items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-white/5 ${focus}`;
const bodyText = 'text-sm leading-6 text-slate-600 dark:text-slate-300';

function greeting(name) {
  const hour = new Date().getHours();
  return `${hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'}, ${name}!`;
}

export default function TeacherHome() {
  const { user, announcementAccessId } = useAuth();
  const flags = useFeatureFlags();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  // The provider keeps previously confirmed options on transient network failures,
  // and clears them on identity changes or denied access. API authorization remains authoritative.
  const enabled = key => !flags.loading && flags.isEnabled(key);
  const classesEnabled = enabled('classes.core');
  const assessmentsEnabled = classesEnabled && enabled('classes.assessment_assignments');
  const recoveryEnabled = recoveryWorkspaceState(user?.role, flags) === 'operational';
  const planningEnabled = enabled('planning.lesson_planner');
  const feedbackAvailable = operationalBankState(user?.role, flags, { feedback: true }) === 'operational';
  const hasWork = assessmentsEnabled || recoveryEnabled || planningEnabled;
  const classes = useHomeResource(classesEnabled ? '/classes?status=active' : null, identity, homeClasses);
  const overview = useHomeResource(assessmentsEnabled || recoveryEnabled ? '/classes/home-overview' : null, identity, homeOverview);
  const planning = useHomeResource(planningEnabled ? '/lesson-plans' : null, identity, homePlans);
  const history = useHomeResource('/materials/history?limit=3', identity, homeList);
  const materials = useHomeResource('/materials?limit=3&sort=recent', identity, homeList);
  const favorites = useHomeResource('/favorites?limit=3', identity, homeList);
  const sets = useHomeResource('/question-bank/question-sets?limit=3', identity, homeList);
  const work = recentHomeWork({ overview: overview.data, plans: planning.data || [],
    activeClassIds: (classes.data || []).map(item => item.id), assessmentsEnabled, recoveryEnabled });
  const attention = homeAttention(overview.data, { assessmentsEnabled, recoveryEnabled });
  const workResources = [overview, planning, ...(assessmentsEnabled ? [classes] : [])].filter(resource => resource.status !== 'idle');
  const noWork = workResources.length > 0 && workResources.every(resource => resource.status === 'ready') && !work.length;
  const firstName = user?.name?.trim().split(/\s+/)[0] || 'professor';
  const previews = [
    ...(enabled('question_bank.typed_preview') ? [{ to: '/exemplos/formatos', label: 'Exemplos de formatos' }] : []),
    ...(enabled('question_bank.feedback_preview') ? [{ to: '/exemplos/devolutivas', label: 'Exemplos de devolutivas' }] : []),
    ...(enabled('question_bank.catalog_preview') ? [{ to: '/exemplos/banco-questoes', label: 'Exemplo do catálogo de questões' }] : []),
  ];

  return (
    <div data-teacher-home className="mx-auto max-w-[1400px] space-y-4 bg-slate-50 px-4 py-4 dark:bg-transparent sm:px-6">
      <header className={`${surface} card flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center`}>
        <div className="min-w-0">
          <h1 data-testid="dashboard-heading" className="break-words text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl">{greeting(firstName)}</h1>
          <p className={`mt-1 ${bodyText}`}>O que vamos preparar para a próxima aula?</p>
        </div>
        <nav aria-label="Buscar recursos para a aula" className="flex flex-wrap gap-2">
          <Link to="/biblioteca" className={`${linkStyle} border border-cyan-200 bg-cyan-50 dark:border-cyan-300/20 dark:bg-cyan-300/10`}><Search size={17} aria-hidden="true" />Buscar material</Link>
          <Link to="/banco-questoes" className={linkStyle}><ClipboardList size={17} aria-hidden="true" />Buscar questões</Link>
        </nav>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          {flags.loading && <section className={`${surface} px-4 py-4`}><p role="status" className={bodyText}>Carregando suas áreas de trabalho…</p></section>}
          {classesEnabled && <Section title="Minhas turmas" icon={UsersRound} to="/turmas" action="Ver todas">
            <ResourceState resource={classes} label="suas turmas" />
            {classes.status === 'ready' && (classes.data.length ? <ul className="divide-y divide-slate-200 dark:divide-white/10">
              {classes.data.slice(0, 3).map(item => <li key={item.id}><Link data-home-class to={classHomePath(item.id)} aria-label={`Abrir turma ${item.name}`} className={rowStyle}>
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-base font-bold text-slate-900 dark:text-white">{item.name}</h3>
                  <p className={`mt-0.5 ${bodyText}`}>{[item.grade?.name, item.academicYear].filter(Boolean).join(' · ')}{Number.isInteger(item.studentCount) && ` · ${item.studentCount} ${pluralize(item.studentCount, 'estudante', 'estudantes')}`}</p>
                  <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-cyan-800 dark:text-cyan-200">Abrir turma<ArrowRight size={15} aria-hidden="true" /></span>
                </div>
              </Link></li>)}
            </ul> : <div className="px-4 py-3"><p className={bodyText}>Você ainda não tem turmas ativas.</p><p className={bodyText}>Cadastre uma turma ou consulte as arquivadas.</p><Link to="/turmas" className={`${linkStyle} mt-1`}>Organizar minhas turmas<ArrowRight size={16} aria-hidden="true" /></Link></div>)}
            {classes.status === 'ready' && classes.data.length > 3 && <p className={`border-t border-slate-200 px-4 py-2 dark:border-white/10 ${bodyText}`}>Mostrando três turmas. Use “Ver todas” para consultar as demais.</p>}
          </Section>}

          {hasWork && <Section title="Retome seu trabalho" icon={History}>
            <ResourceState resource={overview} label="suas avaliações e planos de recomposição" />
            <ResourceState resource={planning} label="seus planejamentos" />
            {work.length > 0 && <ul className="divide-y divide-slate-200 dark:divide-white/10">{work.map(item => <li key={item.key}><WorkRow item={item} /></li>)}</ul>}
            {attention.length > 0 && <nav aria-label="Trabalho para acompanhar" className="border-t border-slate-200 px-1 py-1 dark:border-white/10">{attention.map(item => <Link key={item.text} to={item.to} className={`${linkStyle} justify-start`}>{item.text}<ArrowRight size={15} aria-hidden="true" /></Link>)}</nav>}
            {noWork && !attention.length && <p className={`px-4 py-3 ${bodyText}`}>As avaliações e os planos que você usar aparecerão aqui para continuar depois.</p>}
          </Section>}

          <MaterialLinks title="Materiais que você abriu" icon={History} resource={history} label="os materiais que você abriu" empty="Os materiais consultados aparecerão aqui para você encontrar de novo." />
          <MaterialLinks title="Novos materiais" icon={BookOpen} resource={materials} label="os novos materiais" empty="Ainda não há materiais disponíveis nesta consulta." to="/biblioteca" action="Ver biblioteca" />
        </div>

        <aside aria-label="Outras ferramentas para suas aulas" className="min-w-0 space-y-4">
          <Section title="Para suas aulas" icon={CalendarDays}>
            <nav aria-label="Ferramentas do professor" className="p-1">
              {planningEnabled && <ToolLink to="/planejamento" icon={CalendarDays} label="Planejamentos" />}
              <ToolLink to="/simulados" icon={ClipboardList} label="Meus simulados" />
              {recoveryEnabled && <ToolLink to="/recomposicao" icon={HeartPulse} label="Planos de recomposição" />}
              {feedbackAvailable && <ToolLink to="/banco-questoes/devolutivas" icon={History} label="Devolutivas da turma" />}
              <ToolLink to="/colecoes" icon={BookOpen} label="Laboratórios de materiais" />
            </nav>
          </Section>
          <MaterialLinks title="Seus favoritos" icon={Heart} resource={favorites} label="seus favoritos" empty="Você pode salvar materiais como favoritos para encontrá-los aqui." to="/favoritos" action="Ver todos" />
          <Section title="Simulados recentes" icon={ClipboardList} to="/simulados" action="Ver todos">
            <ResourceState resource={sets} label="seus simulados" />
            {sets.status === 'ready' && (sets.data.length ? <ul className="divide-y divide-slate-200 dark:divide-white/10">{sets.data.slice(0, 3).map(item => <li key={item.id}><Link to={`/simulados/${encodeURIComponent(item.id)}`} className={rowStyle}><span className="min-w-0 flex-1 break-words text-sm font-semibold text-slate-900 dark:text-white">{item.title}</span><ArrowRight size={16} className="shrink-0 text-cyan-700 dark:text-cyan-300" aria-hidden="true" /></Link></li>)}</ul> : <p className={`px-4 py-3 ${bodyText}`}>Seus simulados salvos aparecerão aqui.</p>)}
          </Section>
          {previews.length > 0 && <details className={`${surface} group`}>
            <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-slate-800 dark:text-slate-100 [&::-webkit-details-marker]:hidden ${focus}`}><FlaskConical size={18} aria-hidden="true" /><span className="flex-1">Conhecer os exemplos</span><ChevronDown size={17} className="group-open:rotate-180" aria-hidden="true" /></summary>
            <p className={`px-4 ${bodyText}`}>São demonstrações para explorar. Elas não salvam atividades nas suas turmas.</p>
            <nav aria-label="Exemplos para explorar" className="p-1">{previews.map(item => <ToolLink key={item.to} {...item} icon={FlaskConical} />)}</nav>
          </details>}
          <nav aria-label="Escola e ajuda" className="flex flex-wrap gap-2">
            {enabled('institutions.read_model') && <Link to="/instituicoes" className={linkStyle}><School size={17} aria-hidden="true" />Minha escola</Link>}
            <Link to="/fale-conosco" className={linkStyle}><MessageCircle size={17} aria-hidden="true" />Pedir ajuda</Link>
          </nav>
        </aside>
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, children, to, action }) {
  return <section aria-label={title} className={`${surface} min-w-0 overflow-hidden`}>
    <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-slate-200 px-4 py-1 dark:border-white/10">
      <h2 className="flex min-h-11 items-center gap-2 py-2 text-base font-bold text-slate-900 dark:text-white"><Icon size={18} className="shrink-0 text-cyan-700 dark:text-cyan-300" aria-hidden="true" />{title}</h2>
      {to && <Link to={to} className={linkStyle}>{action}</Link>}
    </div>
    {children}
  </section>;
}

function ResourceState({ resource, label }) {
  if (resource.status === 'idle' || resource.status === 'ready') return null;
  if (resource.status === 'loading') return <p role="status" className={`flex items-center gap-2 px-4 py-4 ${bodyText}`}><LoaderCircle size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />Carregando {label}…</p>;
  return <div className="px-4 py-3"><p role="alert" className="text-sm leading-6 text-amber-900 dark:text-amber-200">Não conseguimos carregar {label}. Tente novamente.</p><button type="button" onClick={resource.retry} aria-label={`Tentar novamente: ${label}`} className={linkStyle}><RefreshCw size={16} aria-hidden="true" />Tentar novamente</button></div>;
}

function WorkRow({ item }) {
  const Icon = item.kind === 'planning' ? CalendarDays : item.kind === 'recovery' ? HeartPulse : ClipboardList;
  const kindLabel = item.kind === 'planning' ? 'Planejamento' : item.kind === 'recovery' ? 'Recomposição' : 'Avaliação';
  return <Link to={item.to} className={rowStyle} aria-label={`${item.action}: ${item.title}`}>
    <Icon size={18} className="shrink-0 self-start mt-1 text-cyan-700 dark:text-cyan-300" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-slate-600 dark:text-slate-300">{kindLabel} · {item.status}</p>
      <h3 className="mt-0.5 break-words text-sm font-bold leading-6 text-slate-900 dark:text-white">{item.title}</h3>
      <p className="break-words text-sm leading-6 text-slate-600 dark:text-slate-300">{[item.context, homeDate(item.updatedAt)].filter(Boolean).join(' · ')}</p>
      <span className="inline-flex items-center gap-1 text-sm font-semibold text-cyan-800 dark:text-cyan-200">{item.action}<ArrowRight size={15} aria-hidden="true" /></span>
    </div>
  </Link>;
}

function MaterialLinks({ title, icon, resource, label, empty, to, action }) {
  return <Section title={title} icon={icon} to={to} action={action}>
    <ResourceState resource={resource} label={label} />
    {resource.status === 'ready' && (resource.data.length ? <ul className="divide-y divide-slate-200 dark:divide-white/10">{resource.data.slice(0, 3).map(item => <li key={item.id}><Link to={`/material/${encodeURIComponent(item.id)}`} className={rowStyle}>
      <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold leading-6 text-slate-900 dark:text-white">{item.title}</h3>{item.discipline_name && <p className={bodyText}>{item.discipline_name}</p>}</div><ArrowRight size={16} className="shrink-0 text-cyan-700 dark:text-cyan-300" aria-hidden="true" />
    </Link></li>)}</ul> : <p className={`px-4 py-3 ${bodyText}`}>{empty}</p>)}
  </Section>;
}

function ToolLink({ to, icon: Icon, label }) {
  return <Link to={to} className={`${rowStyle} rounded-xl text-sm font-semibold text-slate-800 dark:text-slate-100`}><Icon size={18} className="shrink-0 text-cyan-700 dark:text-cyan-300" aria-hidden="true" /><span className="min-w-0 flex-1 break-words">{label}</span><ArrowRight size={15} aria-hidden="true" /></Link>;
}
