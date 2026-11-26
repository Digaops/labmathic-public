import { comparisonPercent, quantity, recoveryComparisonView } from '../services/recoveryComparisonView.mjs';

export default function RecoveryComparison({ comparison }) {
  let view;
  try { view = recoveryComparisonView(comparison); }
  catch { return <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">Não foi possível conferir a comparação. Atualize a página antes de interpretar estes resultados.</p>; }
  return <div data-recovery-comparison className="space-y-3 text-sm">
    <p className={view.legacy ? 'rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200' : 'text-neutral-600 dark:text-neutral-300'}>{view.notice}</p>
    <div className={view.skills.length > 1 ? 'grid gap-3 lg:grid-cols-2' : 'space-y-3'}>{view.skills.map(skill => <article key={skill.code} className="min-w-0 rounded-xl border border-neutral-200 bg-white p-3 dark:border-white/10 dark:bg-white/5">
      <p className="font-bold text-neutral-900 dark:text-white">{skill.code}</p>
      {skill.description && <p className="mt-1 text-neutral-600 dark:text-neutral-300">{skill.description}</p>}
      <p className="mt-2 font-semibold">{skill.groupLabel}</p>
      {!view.legacy && <p className="mt-1 text-neutral-600 dark:text-neutral-300">Com respostas completas: diagnóstico {skill.cohort.diagnosticStudentCount} · verificação {skill.cohort.monitoringStudentCount}.</p>}
      {!view.legacy && (skill.cohort.excludedDiagnosticCount > 0 || skill.cohort.excludedMonitoringCount > 0) && <p className="mt-1 text-neutral-600 dark:text-neutral-300">Quem não tem resultado nas duas etapas não entra na comparação.</p>}
      {(view.legacy || skill.comparable) && <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {['diagnostic', 'monitoring'].map(stage => <div key={stage} className="rounded-lg bg-neutral-50 p-2.5 dark:bg-black/15">
          <dt className="font-semibold">{stage === 'diagnostic' ? 'Diagnóstico' : 'Verificação'}{view.legacy ? ' (registro antigo)' : ''}</dt>
          <dd className="mt-1 text-xl font-bold">{comparisonPercent(skill[`${stage}Rate`])}</dd>
          {!view.legacy && <dd className="mt-1 text-neutral-600 dark:text-neutral-300">{quantity(skill[`${stage}QuestionCount`], 'questão', 'questões')} · {quantity(skill[`${stage}Opportunities`], 'resposta corrigida', 'respostas corrigidas')}</dd>}
        </div>)}
      </dl>}
      {skill.comparable && <p className="mt-2 font-semibold">Diferença de acertos: {skill.delta > 0 ? '+' : ''}{skill.delta.toLocaleString('pt-BR')} pontos percentuais.</p>}
      {!view.legacy && !skill.comparable && <p className="mt-2 font-semibold">Sem comparação disponível.</p>}
      {!view.legacy && skill.comparable && <p className="mt-2 rounded-lg bg-slate-50 p-2.5 leading-relaxed text-neutral-700 dark:bg-slate-900/50 dark:text-neutral-200">{skill.evidenceNotice}</p>}
    </article>)}</div>
  </div>;
}
