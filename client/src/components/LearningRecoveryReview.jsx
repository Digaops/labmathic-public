import { formatCount } from '../utils/pluralize';
import { recoverySummary } from '../services/recoveryLanguage.mjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  LockKeyhole,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Target,
  UsersRound,
} from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { usePlannerLeave } from '../contexts/PlannerNavigationContext';
import LearningRecoveryExecution from './LearningRecoveryExecution';
import { parseRecoveryPlan, parseRecoveryPreview, recoveryReviewFingerprint } from '../services/recoveryPlansView.mjs';

const staleCodes = new Set([
  'stale_preview',
  'stale_results',
  'methodology_changed',
  'priority_not_actionable',
  'preview_not_actionable',
  'recovery_source_changed',
  'stale_plan',
]);

const recoveryLevelMeta = {
  below_expected: {
    label: 'Abaixo do esperado',
    className: 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300',
  },
  developing: {
    label: 'Em desenvolvimento',
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  },
};

function formatPercentage(value) {
  return value === null || value === undefined
    ? '—'
    : `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function createIdempotencyKey() {
  const values = new Uint8Array(16);
  window.crypto.getRandomValues(values);
  return `recovery-${[...values].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function initialReview(preview) {
  return {
    title: `Recomposição · ${preview.source.assessment.title}`.slice(0, 160),
    reviewed: false,
    priorities: Object.fromEntries(preview.priorities.map((priority) => {
      const group = priority.suggestedGroup;
      return [priority.skill.id, {
        selected: true,
        expanded: true,
        suggestedQuestionCount: Math.max(1, priority.reinforcementQuestions.length || 3),
        rationale: '',
        groupEnabled: Boolean(group?.students.length),
        groupTitle: group?.title || `Reforço · ${priority.skill.code}`,
        groupObjective: group?.objective || `Retomar ${priority.skill.description}`,
        studentIds: group?.students.map(({ id }) => id) || [],
      }];
    })),
  };
}

function reviewFromPlan(preview, plan) {
  const savedSkillById = new Map(plan.skills.map((skill) => [skill.skillId, skill]));
  const groupBySkillId = new Map(plan.groups.map((group) => [group.focusSkillId, group]));
  return {
    title: plan.title,
    reviewed: false,
    priorities: Object.fromEntries(preview.priorities.map((priority) => {
      const savedSkill = savedSkillById.get(priority.skill.id);
      const savedGroup = groupBySkillId.get(priority.skill.id);
      const suggestedGroup = priority.suggestedGroup;
      return [priority.skill.id, {
        selected: Boolean(savedSkill),
        expanded: Boolean(savedSkill),
        suggestedQuestionCount: savedSkill?.suggestedQuestionCount
          || Math.max(1, priority.reinforcementQuestions.length || 3),
        rationale: savedSkill?.rationale || '',
        groupEnabled: Boolean(savedGroup),
        groupTitle: savedGroup?.title || suggestedGroup?.title || `Reforço · ${priority.skill.code}`,
        groupObjective: savedGroup?.objective
          || suggestedGroup?.objective
          || `Retomar ${priority.skill.description}`,
        studentIds: savedGroup?.students.map(({ id }) => id)
          || suggestedGroup?.students.map(({ id }) => id)
          || [],
      }];
    })),
  };
}

function LoadingState() {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center p-8 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-violet-600 dark:bg-violet-400/10 dark:text-violet-300">
        <RefreshCw className="animate-spin" size={25} />
      </span>
      <p className="mt-4 font-black text-neutral-800 dark:text-white">Analisando o diagnóstico</p>
      <p className="mt-1 max-w-sm text-sm text-neutral-500 dark:text-neutral-400">Estamos recalculando as prioridades com os resultados mais recentes.</p>
    </div>
  );
}

function EmptyState({ title, description, onBack, onRetry, backLabel = 'Voltar aos resultados' }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center p-8 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300">
        <AlertTriangle size={26} />
      </span>
      <h3 className="mt-4 text-lg font-black text-neutral-900 dark:text-white">{title}</h3>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{description}</p>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <button type="button" className="btn-outline justify-center" onClick={onBack}><ArrowLeft size={16} /> {backLabel}</button>
        {onRetry && <button type="button" className="btn-primary justify-center" onClick={onRetry}><RefreshCw size={16} /> Tentar novamente</button>}
      </div>
    </div>
  );
}

const planStatusMeta = {
  active: {
    label: 'Em acompanhamento',
    description: 'A revisão foi concluída e a composição está preservada como referência para a intervenção.',
    iconClass: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300',
  },
  completed: {
    label: 'Concluído',
    description: 'Este plano foi encerrado e permanece disponível para consulta do histórico pedagógico.',
    iconClass: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300',
  },
  archived: {
    label: 'Arquivado',
    description: 'Este plano está arquivado e permanece disponível somente para consulta.',
    iconClass: 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300',
  },
};

function formatDate(value) {
  if (!value || typeof value !== 'string') return '—';
  const parsed = new Date(value.includes?.('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function ActivePlan({ plan, basePath, onBack, onPlanChange, onReload, executionGuard, backLabel = 'Voltar aos resultados' }) {
  const meta = planStatusMeta[plan.status] || planStatusMeta.active;
  const uniqueStudentCount = new Set(
    plan.groups.flatMap((group) => group.students.map((student) => student.id))
  ).size;
  const referenceDate = plan.completedAt || plan.archivedAt || plan.activatedAt || plan.updatedAt;

  return (
    <div data-recovery-review className="bank-form">
      <div className="bg-neutral-50/60 p-3 dark:bg-black/10 sm:p-4">
        <div className="mx-auto max-w-5xl space-y-4">
          <details className="rounded-xl border border-neutral-200 px-3 dark:border-white/10">
            <summary className="cursor-pointer text-sm font-semibold"><span>{plan.title} · {plan.class.name}</span></summary>
            <p className="mb-2 text-sm">{meta.label} · {plan.class.academicYear} · {meta.description}</p>
            <p className="mb-2 text-sm">{recoverySummary({ priorityCount: plan.skills.length, groupCount: plan.groups.length, studentCount: uniqueStudentCount, plannedQuestionCount: plan.skills.reduce((total, skill) => total + Number(skill.suggestedQuestionCount || 0), 0) })}</p>
            <p className="mb-2 text-sm">Atualizado em {formatDate(referenceDate)}</p>
          </details>

          <LearningRecoveryExecution
            plan={plan}
            basePath={`${basePath}/recovery-plans/${plan.id}`}
            onPlanChange={onPlanChange}
            onReload={onReload}
            guardRef={executionGuard}
          />

          <section className="rounded-3xl border border-neutral-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.035] sm:p-6">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-400/10 dark:text-violet-300"><Target size={18} /></span>
              <div><h4 className="font-black text-neutral-900 dark:text-white">Prioridades pedagógicas</h4><p className="text-xs text-neutral-500 dark:text-neutral-400">Evidências preservadas no momento da confirmação.</p></div>
            </div>
            <div className="mt-4 space-y-3">
              {plan.skills.map((skill) => (
                <article key={skill.code} className="rounded-2xl border border-neutral-200 bg-neutral-50/60 p-4 dark:border-white/10 dark:bg-black/10">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-violet-700 dark:text-violet-300">{skill.code}</strong><span className="rounded-full bg-white px-2 py-1 text-xs font-black uppercase text-neutral-500 dark:bg-white/10 dark:text-neutral-300">Prioridade {skill.priority}</span></div>
                      <p className="mt-2 text-sm font-semibold leading-relaxed text-neutral-700 dark:text-neutral-200">{skill.description}</p>
                      {skill.rationale && <p className="mt-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{skill.rationale}</p>}
                    </div>
                    <div className="flex shrink-0 gap-2 text-xs"><span className="rounded-xl bg-rose-50 px-3 py-2 font-black text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">{formatPercentage(skill.successRateSnapshot)} de acerto</span><span className="rounded-xl bg-cyan-50 px-3 py-2 font-black text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300">{formatCount(skill.suggestedQuestionCount, 'questão', 'questões')}</span></div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-5 dark:border-white/10 dark:bg-white/[0.035] sm:p-6">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-50 text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300"><UsersRound size={18} /></span>
              <div><h4 className="font-black text-neutral-900 dark:text-white">Grupos temporários de apoio</h4><p className="text-xs text-neutral-500 dark:text-neutral-400">Organização pedagógica sem alterar as matrículas da turma.</p></div>
            </div>
            {plan.groups.length ? (
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {plan.groups.map((group) => (
                  <article key={group.id} className="rounded-2xl border border-neutral-200 p-4 dark:border-white/10">
                    <div className="flex flex-wrap items-center gap-2"><h5 className="font-black text-neutral-900 dark:text-white">{group.title}</h5><span className="rounded-full bg-violet-50 px-2 py-1 text-xs font-black text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{group.focusSkillCode}</span></div>
                    <p className="mt-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{group.objective}</p>
                    <div className="mt-3 flex flex-wrap gap-2">{group.students.map((student) => <span key={student.id} className="rounded-xl bg-neutral-100 px-2.5 py-1.5 text-xs font-bold text-neutral-600 dark:bg-white/10 dark:text-neutral-200">{student.displayName}</span>)}</div>
                  </article>
                ))}
              </div>
            ) : <p className="mt-4 rounded-2xl border border-dashed border-neutral-300 p-5 text-sm text-neutral-500 dark:border-white/15 dark:text-neutral-400">Nenhum grupo temporário foi incluído neste plano.</p>}
          </section>

          <div className="flex items-start gap-3 rounded-2xl border border-cyan-200 bg-cyan-50/70 p-4 text-xs leading-relaxed text-cyan-900 dark:border-cyan-400/20 dark:bg-cyan-400/5 dark:text-cyan-100"><ShieldCheck className="mt-0.5 shrink-0" size={17} /><p>Os percentuais acima são registros descritivos do diagnóstico de origem e não representam proficiência TRI.</p></div>
        </div>
      </div>
      <footer className="border-t border-neutral-200 bg-white p-3 dark:border-white/10 dark:bg-[#0D192B] sm:p-4"><div className="mx-auto flex max-w-5xl justify-end"><button type="button" className="btn-primary" onClick={onBack}><ArrowLeft size={16} /> {backLabel}</button></div></footer>
    </div>
  );
}

function CreatedPlan({ plan, onBack, onReview, backLabel = 'Voltar aos resultados' }) {
  return <div data-recovery-review className="bank-form space-y-3 p-3 sm:p-4">
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-400/20 dark:bg-emerald-400/5">
      <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Rascunho salvo · aguardando revisão final</p>
      <h3 className="mt-2 text-lg font-bold">Agora revise e ative o plano</h3>
      <p className="mt-2 text-sm"><strong>{plan.title}</strong> · {formatCount(plan.skills.length, 'prioridade', 'prioridades')} · {formatCount(plan.groups.length, 'grupo de apoio', 'grupos de apoio')}.</p>
      <p className="mt-2 text-sm">Confira o conteúdo e marque a confirmação pedagógica antes de ativar. Nada foi aplicado aos estudantes automaticamente.</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn-primary" onClick={onReview}>Revisar rascunho agora</button><button type="button" className="btn-outline" onClick={onBack}>{backLabel}</button></div>
    </section>
  </div>;
}

function StudentSelector({ priority, state, onChange }) {
  const students = priority.studentCandidates || priority.suggestedGroup?.students || [];
  const suggestedStudentIds = new Set(
    (priority.suggestedGroup?.students || []).map(({ id }) => id)
  );
  if (!students.length) return null;
  return (
    <div className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50/70 p-4 dark:border-white/10 dark:bg-black/10">
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 rounded border-neutral-300 text-violet-600 focus:ring-violet-400" checked={state.groupEnabled} onChange={(event) => onChange({ groupEnabled: event.target.checked })} />
        <span><strong className="block text-sm text-neutral-800 dark:text-white">Criar grupo temporário de apoio</strong><span className="mt-1 block text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">O grupo organiza a intervenção; não altera matrículas nem rotula o estudante permanentemente.</span></span>
      </label>
      {state.groupEnabled && (
        <div className="mt-4 space-y-4 border-t border-neutral-200 pt-4 dark:border-white/10">
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="text-sm font-bold text-neutral-500 dark:text-neutral-400">Nome do grupo<input className="input mt-1.5" maxLength={120} value={state.groupTitle} onChange={(event) => onChange({ groupTitle: event.target.value })} /></label>
            <label className="text-sm font-bold text-neutral-500 dark:text-neutral-400">Objetivo<input className="input mt-1.5" maxLength={1000} value={state.groupObjective} onChange={(event) => onChange({ groupObjective: event.target.value })} /></label>
          </div>
          <fieldset>
            <legend className="text-xs font-black uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Composição do grupo · {state.studentIds.length} de {students.length}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {students.map((student) => {
                const checked = state.studentIds.includes(student.id);
                const suggested = suggestedStudentIds.has(student.id);
                return (
                  <label key={student.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${checked ? 'border-violet-300 bg-violet-50 dark:border-violet-400/30 dark:bg-violet-400/10' : 'border-neutral-200 bg-white dark:border-white/10 dark:bg-white/[0.025]'}`}>
                    <input type="checkbox" className="h-4 w-4 rounded border-neutral-300 text-violet-600 focus:ring-violet-400" checked={checked} onChange={() => onChange({ studentIds: checked ? state.studentIds.filter((id) => id !== student.id) : [...state.studentIds, student.id] })} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5"><strong className="break-words text-sm text-neutral-800 dark:text-white">{student.displayName}</strong>{suggested && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-black uppercase text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">Sugerido</span>}</span>
                      <span className="mt-0.5 block text-sm text-neutral-400">{formatPercentage(student.successRate)} · {formatCount(student.opportunityCount, 'resposta', 'respostas')}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {state.studentIds.length === 0 && <p role="alert" className="flex items-center gap-2 text-xs font-bold text-rose-600 dark:text-rose-300"><AlertTriangle size={14} /> Selecione ao menos um estudante ou desative o grupo.</p>}
        </div>
      )}
    </div>
  );
}

function PriorityCard({ priority, state, onChange }) {
  const meta = recoveryLevelMeta[priority.result.level] || recoveryLevelMeta.developing;
  const availableQuestions = priority.reinforcementQuestions.length;
  const monitoringQuestions = priority.monitoringQuestions.length;
  return (
    <article data-recovery-priority={priority.skill.id} className={`rounded-2xl border transition ${state.selected ? 'border-violet-300 bg-white shadow-sm dark:border-violet-400/30 dark:bg-white/[0.035]' : 'border-neutral-200 bg-neutral-50/70 opacity-75 dark:border-white/10 dark:bg-white/[0.02]'}`}>
      <div className="p-3 sm:p-4">
        <div className="flex items-start gap-2">
          <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"><input aria-label={`Selecionar ${priority.skill.code}`} type="checkbox" className="h-5 w-5 rounded border-neutral-300 text-violet-600 focus:ring-violet-400" checked={state.selected} onChange={(event) => onChange({ selected: event.target.checked })} /></label>
          <div className="min-w-0 flex-1"><strong className="block py-2 text-violet-700 dark:text-violet-300">{priority.skill.code}</strong><span className={`inline-block rounded-lg px-2 py-1 text-xs font-semibold ${meta.className}`}>{meta.label}</span></div>
          <button type="button" disabled={!state.selected} className="rounded-xl p-2 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-white/10" onClick={() => onChange({ expanded: !state.expanded })} aria-expanded={state.expanded && state.selected} aria-label={state.expanded && state.selected ? 'Recolher detalhes' : 'Expandir detalhes'}>{state.expanded && state.selected ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
        </div>
        <p className="mt-2 text-sm font-semibold leading-relaxed text-neutral-700 dark:text-neutral-200">{priority.skill.description}</p>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">Prioridade {priority.priority} · {formatPercentage(priority.result.successRate)} de acerto · {formatCount(priority.result.questionCount, 'questão', 'questões')} · {formatCount(priority.result.opportunityCount, 'resposta', 'respostas')}</p>
      </div>
      {state.expanded && state.selected && (
        <div className="border-t border-neutral-200 p-4 dark:border-white/10 sm:p-5">
          <details className="text-sm"><summary className="cursor-pointer font-semibold text-cyan-700 dark:text-cyan-300">Sugestões disponíveis e evidências</summary>
            <p className="py-2">{formatCount(availableQuestions, 'questão de reforço', 'questões de reforço')} · {formatCount(priority.materials.length, 'material com habilidade validada', 'materiais com habilidade validada')} · {formatCount(monitoringQuestions, 'questão para verificar a aprendizagem', 'questões para verificar a aprendizagem')}.</p>
            <p className="pb-2">{priority.result.evidence.notice}</p>
          </details>
          <div className="mt-4 grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
            <label className="text-sm font-bold text-neutral-500 dark:text-neutral-400">Questões previstas<select aria-label="Questões previstas" className="input mt-1.5" value={state.suggestedQuestionCount} onChange={(event) => onChange({ suggestedQuestionCount: Number(event.target.value) })}>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} {value === 1 ? 'questão' : 'questões'}</option>)}</select></label>
            <label className="text-sm font-bold text-neutral-500 dark:text-neutral-400">Por que trabalhar esta habilidade? (opcional)<textarea className="input mt-1.5 min-h-20 resize-y" maxLength={1000} value={state.rationale} onChange={(event) => onChange({ rationale: event.target.value })} placeholder="Ex.: retomar antes de avançar para a próxima habilidade." /></label>
          </div>
          <StudentSelector priority={priority} state={state} onChange={onChange} />
        </div>
      )}
    </article>
  );
}

export default function LearningRecoveryReview({
  schoolClass,
  assignment,
  onBack: onExit,
  closeGuardRef = null,
  initialPlanId = null,
  onPlanChange = null,
  backLabel = 'Voltar aos resultados',
}) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(null);
  const [createdPlan, setCreatedPlan] = useState(null);
  const [plan, setPlan] = useState(null);
  const idempotencyKeyRef = useRef(null);
  const executionGuard = useRef(() => true);
  const requestRef = useRef(null), live = useRef(true), writePending = useRef(false), baseline = useRef(''), errorRef = useRef(null);
  const dirty = Boolean(review && recoveryReviewFingerprint(review) !== baseline.current);
  const needsVerification = Boolean(uncertain) || stale;
  usePlannerLeave(dirty || needsVerification, () => writePending.current, 'recovery');
  const saveReviewBaseline = useCallback(next => { baseline.current = recoveryReviewFingerprint(next); setReview(next); }, []);
  const mayLeave = () => {
    if (plan && plan.status !== 'draft') return executionGuard.current();
    if (writePending.current) { toast.error('Aguarde a confirmação do envio antes de sair.'); return false; }
    return (!dirty && !needsVerification) || window.confirm(needsVerification ? 'Há uma atualização do plano a conferir. Sair e conferir depois?' : 'Há alterações não salvas no plano. Sair sem salvá-las?');
  };
  useEffect(() => { if (closeGuardRef) closeGuardRef.current = mayLeave; return () => { if (closeGuardRef) closeGuardRef.current = () => true; }; });
  const onBack = () => { if (mayLeave()) onExit(); };
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; requestRef.current?.abort(); };
  }, [closeGuardRef]);
  useEffect(() => { if(error && errorRef.current) { errorRef.current.focus({preventScroll:true});errorRef.current.scrollIntoView({block:'center'}); } }, [error]);
  const basePath = `/classes/${schoolClass.id}/assessments/${assignment.id}/results`;

  const loadPreview = useCallback(async () => {
    requestRef.current?.abort(); const controller = new AbortController(); requestRef.current = controller;
    const get = async path => {
      const response = await api.get(path,{signal:controller.signal,timeout:15000});
      if(controller.signal.aborted || !live.current) throw new Error('Consulta cancelada.');
      return response;
    };
    try {
      setLoading(true);
      setCreatedPlan(null);
      setError('');
      setStale(false);
      setUncertain(null);
      let requestedPlan = null;
      if (initialPlanId) {
        const planResponse = await get(`${basePath}/recovery-plans/${initialPlanId}`);
        requestedPlan = parseRecoveryPlan(planResponse.data.plan);
        if (requestedPlan.id !== initialPlanId || requestedPlan.class.id !== schoolClass.id || requestedPlan.sourceAssessment.id !== assignment.id) throw new Error('Plano fora do contexto solicitado.');
        if (requestedPlan.status !== 'draft') {
          setPreview(null);
          saveReviewBaseline(null);
          setPlan(requestedPlan);
          return;
        }
      }

      const response = await get(`${basePath}/recovery-preview`);
      const nextPreview = parseRecoveryPreview(response.data);
      if(nextPreview.source.assessment.id !== assignment.id) throw new Error('Avaliação fora do contexto solicitado.');
      setPreview(nextPreview);
      if (requestedPlan) {
        setPlan(requestedPlan);
        saveReviewBaseline(reviewFromPlan(nextPreview, requestedPlan));
      } else if (nextPreview.existingPlan) {
        const planResponse = await get(
          `${basePath}/recovery-plans/${nextPreview.existingPlan.id}`
        );
        const nextPlan = parseRecoveryPlan(planResponse.data.plan);
        if(nextPlan.id !== nextPreview.existingPlan.id || nextPlan.class.id !== schoolClass.id || nextPlan.sourceAssessment.id !== assignment.id) throw new Error('Plano fora do contexto solicitado.');
        setPlan(nextPlan);
        saveReviewBaseline(nextPlan.status === 'draft' ? reviewFromPlan(nextPreview, nextPlan) : null);
      } else {
        setPlan(null);
        saveReviewBaseline(initialReview(nextPreview));
      }
      idempotencyKeyRef.current = createIdempotencyKey();
    } catch (requestError) {
      if(controller.signal.aborted || !live.current) return;
      setPreview(null);
      setReview(null);
      setPlan(null);
      setError(requestError.response?.data?.error || 'Não foi possível gerar a prévia de recomposição.');
    } finally {
      if(!controller.signal.aborted && live.current) setLoading(false);
    }
  }, [basePath, initialPlanId, schoolClass.id, assignment.id, saveReviewBaseline]);
  const reloadPreview = () => { if (!writePending.current && ((!dirty && !uncertain) || window.confirm('Recarregar consultará o servidor e descartará as alterações não salvas deste plano. Continuar?'))) loadPreview(); };

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  function updatePriority(skillId, patch) {
    setReview((current) => ({
      ...current,
      reviewed: Object.keys(patch).every(key => key === 'expanded') ? current.reviewed : false,
      priorities: {
        ...current.priorities,
        [skillId]: { ...current.priorities[skillId], ...patch },
      },
    }));
  }

  const selectedPriorities = useMemo(() => {
    if (!preview || !review) return [];
    return preview.priorities.filter(({ skill }) => review.priorities[skill.id]?.selected);
  }, [preview, review]);

  const invalidGroup = selectedPriorities.some(({ skill }) => {
    const state = review.priorities[skill.id];
    return state.groupEnabled && (!state.studentIds.length || !state.groupTitle.trim() || !state.groupObjective.trim());
  });
  const canConfirm = Boolean(
    review?.title.trim()
    && selectedPriorities.length
    && review?.reviewed
    && !invalidGroup
    && !saving
    && !stale
    && !uncertain
  );
  const canSaveDraft = Boolean(
    plan?.status === 'draft'
    && review?.title.trim()
    && selectedPriorities.length
    && !invalidGroup
    && !saving
    && !stale
    && !uncertain
  );

  function buildPayload(expectedPlanRevision = undefined) {
    return {
      expectedAssessmentRevision: preview.source.assessment.revision,
      expectedResultRevision: preview.source.resultRevision,
      methodologyVersion: preview.methodology.version,
      ...(expectedPlanRevision ? { expectedPlanRevision } : {}),
      title: review.title.trim(),
      acceptedPriorities: selectedPriorities.map(({ skill }) => {
        const state = review.priorities[skill.id];
        return {
          skillId: skill.id,
          suggestedQuestionCount: state.suggestedQuestionCount,
          rationale: state.rationale.trim() || undefined,
          group: state.groupEnabled ? {
            title: state.groupTitle.trim(),
            objective: state.groupObjective.trim(),
            studentIds: state.studentIds,
          } : undefined,
        };
      }),
    };
  }

  function readWrittenPlan(response, status, expectedId = null) {
    const value = parseRecoveryPlan(response.data?.plan);
    if (value.status !== status || (expectedId && value.id !== expectedId)
      || value.class.id !== schoolClass.id || value.sourceAssessment.id !== assignment.id) {
      throw new Error('Resposta do envio fora do contexto solicitado.');
    }
    return value;
  }

  async function submitConfirmation(payload, idempotencyKey) {
    if (writePending.current) return;
    writePending.current = true;
    try {
      setSaving(true);
      setError('');
      const response = await api.post(`${basePath}/recovery-plans`, payload, {
        headers: { 'Idempotency-Key': idempotencyKey },
        timeout: 20000,
      });
      if (!live.current) return;
      const savedPlan = readWrittenPlan(response, 'draft');
      setCreatedPlan(savedPlan);
      setPlan(savedPlan);
      saveReviewBaseline(reviewFromPlan(preview, savedPlan));
      onPlanChange?.(savedPlan);
      setUncertain(null);
      toast.success(response.data.replayed ? 'Plano confirmado anteriormente e recuperado com segurança.' : 'Plano de recomposição criado como rascunho.');
    } catch (requestError) {
      if (!live.current) return;
      const code = requestError.response?.data?.code;
      if (!requestError.response || requestError.response.status >= 500) {
        setUncertain({ payload, idempotencyKey });
        setError('Não foi possível verificar o resultado do envio. Verifique usando a mesma operação para evitar duplicidade.');
      } else if (staleCodes.has(code)) {
        setStale(true);
        setError(requestError.response.data.error || 'A prévia ficou desatualizada.');
      } else if (code === 'recovery_plan_exists') {
        setStale(true);
        setError('Já existe um plano para esta avaliação. Recarregue para consultá-lo antes de continuar.');
      } else {
        setError(requestError.response?.data?.error || 'Não foi possível confirmar o plano. Confira os dados antes de tentar novamente.');
      }
    } finally {
      writePending.current = false;
      if (live.current) setSaving(false);
    }
  }

  async function confirm() {
    if (!canConfirm) return;
    await submitConfirmation(buildPayload(), idempotencyKeyRef.current);
  }

  async function saveDraft() {
    if (!canSaveDraft || writePending.current) return;
    writePending.current = true;
    try {
      setSaving(true);
      setError('');
      const response = await api.put(
        `${basePath}/recovery-plans/${plan.id}`,
        buildPayload(plan.revision),
        { timeout: 20000 }
      );
      if (!live.current) return;
      const savedPlan = readWrittenPlan(response, 'draft', plan.id);
      setPlan(savedPlan);
      saveReviewBaseline(reviewFromPlan(preview, savedPlan));
      onPlanChange?.(savedPlan);
      toast.success('Rascunho atualizado com segurança.');
    } catch (requestError) {
      if (!live.current) return;
      const code = requestError.response?.data?.code;
      if (!requestError.response || requestError.response.status >= 500) {
        setStale(true);
        setError('Não foi possível verificar o envio. Recarregue para verificar se o rascunho foi salvo.');
      } else if (staleCodes.has(code)) {
        setStale(true);
        setError(requestError.response?.data?.error || 'O rascunho precisa ser recarregado.');
      } else {
        setError(requestError.response?.data?.error || 'Não foi possível salvar o rascunho. Confira os dados antes de tentar novamente.');
      }
    } finally {
      writePending.current = false;
      if (live.current) setSaving(false);
    }
  }

  async function activatePlan() {
    if (!canConfirm || plan?.status !== 'draft' || writePending.current) return;
    writePending.current = true;
    try {
      setSaving(true);
      setError('');
      const response = await api.post(
        `${basePath}/recovery-plans/${plan.id}/activate`,
        { ...buildPayload(plan.revision), reviewConfirmed: true },
        { timeout: 20000 }
      );
      if (!live.current) return;
      const savedPlan = readWrittenPlan(response, 'active', plan.id);
      setPlan(savedPlan);
      saveReviewBaseline(null);
      onPlanChange?.(savedPlan);
      toast.success(response.data.replayed
        ? 'Este plano já estava revisado e ativo.'
        : 'Revisão concluída. O plano de recomposição está ativo.');
    } catch (requestError) {
      if (!live.current) return;
      const code = requestError.response?.data?.code;
      if (!requestError.response || requestError.response.status >= 500) {
        setStale(true);
        setError('Não foi possível verificar o envio. Recarregue para verificar se o plano foi ativado.');
      } else if (staleCodes.has(code)) {
        setStale(true);
        setError(requestError.response?.data?.error || 'O rascunho precisa ser recarregado.');
      } else {
        setError(requestError.response?.data?.error || 'Não foi possível concluir a revisão. Confira o plano antes de tentar novamente.');
      }
    } finally {
      writePending.current = false;
      if (live.current) setSaving(false);
    }
  }

  function openCreatedPlanReview() {
    setCreatedPlan(null);
    saveReviewBaseline(reviewFromPlan(preview, plan));
  }

  if (loading) return <LoadingState />;
  if (createdPlan) return <CreatedPlan plan={createdPlan} onBack={onBack} onReview={openCreatedPlanReview} backLabel={backLabel} />;
  if (plan && plan.status !== 'draft') return <ActivePlan plan={plan} basePath={basePath} onBack={onBack} onPlanChange={(updatedPlan) => { setPlan(updatedPlan); onPlanChange?.(updatedPlan); }} onReload={reloadPreview} executionGuard={executionGuard} backLabel={backLabel} />;
  if (!preview || !review) return <EmptyState title="Prévia indisponível" description={error} onBack={onBack} onRetry={reloadPreview} backLabel={backLabel} />;
  if (!preview.isActionable) return <EmptyState title="Nenhuma prioridade encontrada" description="Os resultados atuais não indicam habilidades abaixo das faixas definidas para recomposição." onBack={onBack} onRetry={reloadPreview} backLabel={backLabel} />;

  return (
    <div data-recovery-review className="bank-form">
      <div className="bg-neutral-50/60 p-3 dark:bg-black/10 sm:p-4">
        <div className="mx-auto max-w-5xl space-y-4">
          <button type="button" className="inline-flex items-center gap-2 text-sm font-black text-neutral-500 hover:text-violet-700 dark:text-neutral-400 dark:hover:text-violet-300" onClick={onBack}><ArrowLeft size={17} /> {backLabel}</button>

          <section className="space-y-2">
            <h3 className="text-lg font-bold">{plan ? 'Confira e ajuste antes de ativar' : 'Escolha o que fará parte do plano'}</h3>
            <p className="text-sm">{plan ? 'Você ainda pode editar o rascunho. Ao confirmar a revisão, as prioridades e os grupos ficarão fixos para preservar o histórico.' : 'Escolha as habilidades e confira os grupos. Você poderá revisar o rascunho antes de ativar.'}</p>
            <label className="block text-sm font-semibold">Título do plano<input className="input mt-1" disabled={saving || stale || Boolean(uncertain)} maxLength={160} value={review.title} onChange={(event) => setReview((current) => ({ ...current, title: event.target.value, reviewed: false }))} /></label>
            <p className="text-sm text-neutral-600 dark:text-neutral-300">Prioridades selecionadas: {selectedPriorities.length} de {preview.priorities.length} · {formatCount(preview.source.overview.submittedCount, 'correção considerada', 'correções consideradas')}</p>
          </section>

          {(error || stale || uncertain) && (
            <div role="alert" ref={errorRef} tabIndex={-1} className={`rounded-2xl border p-4 ${stale || uncertain ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100' : 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-100'}`}>
              <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 shrink-0" size={18} /><div><p className="text-sm font-black">{stale ? 'A prévia precisa ser refeita' : uncertain ? 'Confirmação aguardando verificação' : 'Não foi possível confirmar'}</p><p className="mt-1 text-xs leading-relaxed opacity-80">{error}</p></div></div>
              {(stale || uncertain) && <div className="mt-3 flex flex-col gap-2 pl-7 sm:flex-row"><button type="button" className="btn-outline justify-center" onClick={reloadPreview}><RefreshCw size={15} /> Recarregar prévia</button>{uncertain && <button type="button" className="btn-primary justify-center" disabled={saving} onClick={() => submitConfirmation(uncertain.payload, uncertain.idempotencyKey)}>{saving ? <RefreshCw className="animate-spin" size={15} /> : <ShieldCheck size={15} />} Verificar confirmação</button>}</div>}
            </div>
          )}

          <fieldset className="space-y-3" disabled={saving || stale || Boolean(uncertain)}>
            {preview.priorities.map((priority) => <PriorityCard key={priority.skill.id} priority={priority} state={review.priorities[priority.skill.id]} onChange={(patch) => updatePriority(priority.skill.id, patch)} />)}
          </fieldset>

          {preview.warnings.length > 0 && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-400/20 dark:bg-amber-400/5">
              <h4 className="flex items-center gap-2 text-sm font-black text-amber-900 dark:text-amber-100"><AlertTriangle size={17} /> Pontos para observar</h4>
              <ul className="mt-2 space-y-1 pl-5 text-xs leading-relaxed text-amber-800/80 dark:text-amber-100/70">{preview.warnings.map((warning) => <li key={warning} className="list-disc">{warning}</li>)}</ul>
            </section>
          )}

          <section className="rounded-2xl border border-cyan-200 bg-cyan-50/70 p-4 dark:border-cyan-400/20 dark:bg-cyan-400/5">
            <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 shrink-0 text-cyan-700 dark:text-cyan-300" size={19} /><div><h4 className="text-sm font-black text-cyan-900 dark:text-cyan-100">Decisão do professor, sem automatismos</h4><p className="mt-1 text-xs leading-relaxed text-cyan-800/75 dark:text-cyan-100/70">{preview.methodology.notice} Os percentuais são descritivos e não representam proficiência TRI.</p></div></div>
          </section>
        </div>
      </div>

      <footer className="border-t border-neutral-200 bg-white p-3 dark:border-white/10 dark:bg-[#0D192B] sm:p-4">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-neutral-50 px-3 py-2.5 dark:bg-white/5">
            <input type="checkbox" disabled={saving || stale || Boolean(uncertain)} className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-violet-600 focus:ring-violet-400" checked={review.reviewed} onChange={(event) => setReview((current) => ({ ...current, reviewed: event.target.checked }))} />
            <span><strong className="block text-xs text-neutral-800 dark:text-white">{plan ? 'Conferi o plano e confirmo esta revisão' : 'Conferi as prioridades e os grupos'}</strong><span className="block text-sm text-neutral-400">{plan ? 'Ao concluir, o plano ficará ativo e seu conteúdo será preservado.' : 'O plano será criado como rascunho para a revisão final.'}</span></span>
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <button type="button" className="btn-outline justify-center" onClick={onBack} disabled={saving}>Cancelar</button>
            {plan ? (
              <>
                <button type="button" className="btn-outline justify-center" onClick={saveDraft} disabled={!canSaveDraft}>{saving ? <RefreshCw className="animate-spin" size={16} /> : <Save size={16} />} Salvar rascunho</button>
                <button type="button" className="btn-primary justify-center" onClick={activatePlan} disabled={!canConfirm}>{saving ? <RefreshCw className="animate-spin" size={16} /> : <LockKeyhole size={16} />} Concluir revisão</button>
              </>
            ) : (
              <button type="button" className="btn-primary justify-center" onClick={confirm} disabled={!canConfirm}>{saving ? <RefreshCw className="animate-spin" size={16} /> : <Sparkles size={16} />} Criar plano em rascunho</button>
            )}
          </div>
        </div>
        {!selectedPriorities.length && <p className="mx-auto mt-2 max-w-5xl text-right text-xs font-bold text-rose-600 dark:text-rose-300">Selecione ao menos uma prioridade.</p>}
        {invalidGroup && <p className="mx-auto mt-2 max-w-5xl text-right text-xs font-bold text-rose-600 dark:text-rose-300">Revise os dados dos grupos selecionados.</p>}
      </footer>
    </div>
  );
}
