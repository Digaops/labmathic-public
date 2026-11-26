import { useCallback, useRef, useState } from 'react';
import AssessmentDialog from './AssessmentDialog';
import SchoolCoordinationComparison from './SchoolCoordinationComparison';
import useHomeResource from '../hooks/useHomeResource';
import { coordinationCount, coordinationDate } from '../services/schoolCoordinationView.mjs';
import { parseCoordinationSupport, supportNextStep, supportVerificationText } from '../services/schoolCoordinationSupportView.mjs';

export default function SchoolCoordinationSupport({ identity, schoolId, classId, onClose }) {
  const [page, setPage] = useState(1);
  const [comparisonId, setComparisonId] = useState(null);
  const [expandedPlanId, setExpandedPlanId] = useState(null);
  const start = useRef(null);
  const parse = useCallback(data => parseCoordinationSupport(data, schoolId, classId, page), [schoolId, classId, page]);
  const resource = useHomeResource(`/school-coordination/schools/${encodeURIComponent(schoolId)}/classes/${encodeURIComponent(classId)}/support?page=${page}`, identity, parse);
  const closeDetails = () => { setComparisonId(null); setExpandedPlanId(null); };
  const changePage = next => { closeDetails(); setPage(next); start.current?.focus(); start.current?.scrollIntoView({ block: 'start' }); };
  const data = resource.data;
  return <AssessmentDialog title="Acompanhar apoio à turma" onClose={onClose}>
    <div data-coordination-support className="space-y-3 p-3 text-sm leading-6 sm:p-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p ref={start} tabIndex={-1}>Planos registrados pelo professor · consulta atual</p>
        <button className="btn-outline min-h-11" disabled={resource.status === 'loading'} onClick={() => { closeDetails(); resource.retry(); }}>Atualizar apoio</button>
      </div>
      {resource.status === 'loading' && <p role="status">Conferindo o acesso e consultando os planos…</p>}
      {resource.status === 'error' && <div role="alert"><p>Não foi possível consultar os planos. Tente atualizar. Se continuar, peça à administração para conferir a liberação e os vínculos da escola.</p><p>Os dados anteriores foram ocultados.</p></div>}
      {data && <>
        <header><h3 className="text-base font-bold">{data.class.name} · {data.class.academicYear}</h3><p>{data.school.name} · {data.school.municipality}</p></header>
        <p>Veja o andamento na lista e abra um plano para conversar sobre os próximos passos. Esta consulta não registra um acordo nem altera o planejamento.</p>
        {!data.items.length ? <div className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <h4 className="font-bold">{page === 1 ? 'Nenhum plano disponível nesta consulta' : 'Nenhum plano nesta página'}</h4>
          <p>{page === 1 ? 'Somente planos ativados ou concluídos aparecem aqui. Rascunhos e planos arquivados ficam de fora. A ausência de um plano não significa ausência de apoio em sala.' : 'A lista pode ter mudado. Volte à primeira página para conferir.'}</p>
          {page > 1 && <button className="btn-outline mt-2 min-h-11" onClick={() => changePage(1)}>Voltar à primeira página</button>}
        </div> : <ol aria-label="Planos de apoio da turma" className="space-y-2">{data.items.map((plan, index) => <li key={plan.id} className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold">Plano de apoio {(page - 1) * 20 + index + 1}</h4><span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold dark:bg-white/10">{plan.status === 'active' ? 'Em andamento' : 'Concluído pelo professor'}</span></div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-slate-600 dark:text-slate-300">Ativado em {coordinationDate(plan.activatedAt)} (Brasília)</p>
              <p>{!plan.execution ? 'Organização das aulas ainda não disponível.' : plan.execution.total === 0 ? 'Ainda não há aulas de apoio registradas.'
                : `Aulas: ${coordinationCount(plan.execution.taught, 'realizada', 'realizadas')} · ${coordinationCount(plan.execution.planned, 'prevista', 'previstas')} · ${coordinationCount(plan.execution.skipped, 'não realizada', 'não realizadas')}`}</p>
              {plan.execution?.status === 'archived' && <p className="text-amber-800 dark:text-amber-200">Organização das aulas arquivada</p>}
              <p>{supportVerificationText(plan.verification)}</p>
            </div>
            <button className="btn-outline min-h-11 self-start sm:self-auto" aria-expanded={expandedPlanId === plan.id} aria-controls={`support-details-${plan.id}`}
              aria-label={`${expandedPlanId === plan.id ? 'Recolher detalhes' : 'Ver detalhes'} do plano ${(page - 1) * 20 + index + 1}`}
              onClick={() => { setComparisonId(null); setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id); }}>
              {expandedPlanId === plan.id ? 'Recolher detalhes' : 'Ver detalhes'}
            </button>
          </div>
          <div id={`support-details-${plan.id}`} hidden={expandedPlanId !== plan.id}>
          {expandedPlanId === plan.id && <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-white/10">
            <p>Avaliação de origem encerrada em {coordinationDate(plan.sourceClosedAt)} (Brasília).</p>
            {plan.verification.closedAt && <p>Nova avaliação encerrada em {coordinationDate(plan.verification.closedAt)} (Brasília).</p>}
            {plan.execution?.skipped > 0 && <p className="text-amber-800 dark:text-amber-200">Aulas não realizadas não contam como apoio realizado.</p>}
            <div className="rounded-lg bg-sky-50 p-3 dark:bg-sky-950/40"><h5 className="font-semibold">Próxima conversa com o professor</h5><p>{supportNextStep(plan)}</p></div>
          {plan.verification.status === 'closed' && <>
            <button className="btn-outline min-h-11" aria-expanded={comparisonId === plan.id}
              aria-controls={`comparison-${plan.id}`} aria-label={`${comparisonId === plan.id ? 'Recolher comparação' : 'Comparar aprendizagem'} do plano ${(page - 1) * 20 + index + 1}`}
              onClick={() => setComparisonId(comparisonId === plan.id ? null : plan.id)}>{comparisonId === plan.id ? 'Recolher comparação' : 'Comparar aprendizagem'}</button>
            <div id={`comparison-${plan.id}`} hidden={comparisonId !== plan.id}>
              {comparisonId === plan.id && <SchoolCoordinationComparison key={plan.id} identity={identity} schoolId={schoolId} classId={classId} planId={plan.id} />}
            </div>
          </>}
          </div>}
          </div>
        </li>)}</ol>}
        {data.total > 20 || page > 1 ? <nav aria-label="Páginas dos planos" className="flex flex-wrap items-center justify-between gap-2">
          <button className="btn-outline min-h-11" disabled={page === 1} onClick={() => changePage(page - 1)}>Planos anteriores</button>
          <span>Página {page} · {coordinationCount(data.total, 'plano', 'planos')}</span>
          <button className="btn-outline min-h-11" disabled={page * 20 >= data.total || page >= 9999} onClick={() => changePage(page + 1)}>Próximos planos</button>
        </nav> : null}
        <details className="rounded-lg border border-slate-200 p-3 dark:border-white/10"><summary className="min-h-11 cursor-pointer py-2 font-semibold">O que este acompanhamento permite concluir?</summary>
          <div className="space-y-2"><p>Os planos em andamento aparecem primeiro, seguidos dos concluídos. Dentro de cada grupo, os ativados mais recentemente vêm antes. A numeração indica apenas a posição nesta consulta.</p>
            <p>As aulas são contadas conforme o registro do professor. Concluir um plano ou encerrar uma avaliação não comprova melhoria da aprendizagem. Quando houver verificação encerrada, use “Comparar aprendizagem” para conferir as habilidades com dados suficientes.</p>
            <p>A nova avaliação é a vinculada ao próprio plano, não a última avaliação da turma. “Correções disponíveis” exige pelo menos 5 correções concluídas, sem dispensas; não significa que toda a turma respondeu.</p>
            <p>Nomes, respostas individuais, composição dos grupos, títulos particulares e anotações docentes não são exibidos. Os detalhes individuais continuam na conta do professor. Atualize para conferir novos registros.</p>
          </div>
        </details>
      </>}
    </div>
  </AssessmentDialog>;
}
