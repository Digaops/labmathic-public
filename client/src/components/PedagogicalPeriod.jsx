import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { parsePedagogicalPeriod, periodInputError } from '../services/pedagogicalPeriodView.mjs';
import { formatCount } from '../utils/pluralize';
import PedagogicalPeriodCopy from './PedagogicalPeriodCopy';

function today() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const displayDay = value => value.split('-').reverse().join('/');
export default function PedagogicalPeriod({ classId, onSelect }) {
  const [end, setEnd] = useState(today);
  const [start, setStart] = useState(() => `${today().slice(0, 7)}-01`);
  const [query, setQuery] = useState(null);
  const [state, setState] = useState({});
  const [inputError, setInputError] = useState('');
  const [copy, setCopy] = useState(null);
  const resultsHeading = useRef(null), alertRef = useRef(null);
  const changed = Boolean(query && (start !== query.start || end !== query.end));
  function consult(next) {
    const error = periodInputError(next.start, next.end);
    setInputError(error);
    if (error) return;
    setState({ loading: true }); setQuery(next);
  }
  useEffect(() => {
    const target = inputError || state.error ? alertRef.current : state.data ? resultsHeading.current : null;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  }, [inputError, state]);
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    setState({ loading: true });
    api.get(`/pedagogical-cycle/classes/${encodeURIComponent(classId)}/period-report`, {
      params: query, signal: controller.signal, timeout: 30000,
    }).then(({ data }) => {
      parsePedagogicalPeriod(data, classId, query);
      if (!controller.signal.aborted) setState({ data, classId });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ error: error.response?.data?.error || 'Não foi possível consultar. Tente novamente.' });
    });
    return () => controller.abort();
  }, [classId, query]);
  const data = state.classId === classId ? state.data : null;
  return <><details data-pedagogical-period className="mt-3 border-t border-neutral-200 pt-3 dark:border-white/10 [overflow-wrap:anywhere]">
    <summary className="cursor-pointer font-semibold">Consultar avaliações por período</summary>
    <p className="my-2 text-sm">Escolha quando as avaliações começaram (horário de Brasília). Rascunhos, agendadas e canceladas não entram nesta consulta.</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); consult({ start, end, page: 1 }); }}>
      <label className="min-w-0"><span className="block text-sm">De</span><input className="input max-w-full" type="date" required value={start} onInput={event => setStart(event.currentTarget.value)} onChange={event => setStart(event.target.value)} /></label>
      <label className="min-w-0"><span className="block text-sm">Até</span><input className="input max-w-full" type="date" required min={start} value={end} onInput={event => setEnd(event.currentTarget.value)} onChange={event => setEnd(event.target.value)} /></label>
      <button className="btn-outline" type="submit" disabled={state.loading}>Consultar período</button>
    </form>
    <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">Até 366 dias por consulta. Você verá os resultados atuais das avaliações iniciadas nessas datas, incluindo correções feitas depois do período.</p>
    {changed && <p role="status" className="mt-2 text-sm font-semibold">Você alterou as datas. Clique em Consultar período para atualizar os resultados.</p>}
    {state.loading && <p role="status" className="mt-3">Consultando avaliações…</p>}
    {(inputError || state.error) && <div ref={alertRef} tabIndex={-1} role="alert" className="mt-3"><p>{inputError || state.error}</p>{!inputError && <button type="button" className="btn-outline mt-2" onClick={() => consult({ ...query })}>Tentar novamente a consulta</button>}</div>}
    {data && <div className="mt-3">
      <h3 ref={resultsHeading} tabIndex={-1} className="scroll-mt-32 text-sm font-semibold">Iniciadas de {displayDay(data.period.start)} a {displayDay(data.period.end)} · {formatCount(data.pagination.total, 'avaliação', 'avaliações')}</h3>
      <p className="mt-1 text-xs">Atualizado em {new Date(data.generatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasília).</p>
      {data.pagination.total > 0 && <div className="my-3">
        <button type="button" className="btn-outline min-h-11" disabled={changed || data.pagination.total > 200} onClick={() => setCopy({ classId, start: query.start, end: query.end })}>Guardar planilha do período</button>
        <p className="mt-1 text-xs">{data.pagination.total > 200 ? 'Há mais de 200 avaliações. Escolha menos dias para guardar a planilha completa.' : 'Uma linha por avaliação, incluindo todas as páginas. Você confere antes de baixar.'}</p>
      </div>}
      {data.assessments.length > 0 && <><p className="my-2 text-sm">A média usa apenas correções concluídas. Pendentes ainda não têm correção concluída: não são nota zero. Estudantes dispensados não entram na contagem de participantes.</p>
      <details className="my-2 text-sm"><summary className="cursor-pointer font-semibold">Como interpretar avaliações diferentes?</summary><p className="mt-1">Não somamos participantes nem calculamos uma média entre avaliações diferentes. As questões e os participantes podem mudar. A diferença de notas, sozinha, não comprova evolução da aprendizagem.</p></details></>}
      {!data.assessments.length && <p className="py-3 text-sm">Nenhuma avaliação iniciada neste período. Tente outras datas.</p>}
      <ul className="divide-y divide-neutral-200 dark:divide-white/10">{data.assessments.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
        <div className="min-w-0 flex-1 break-words"><h3 className="font-semibold">{item.title}</h3>
          <p className="text-sm">Iniciada em {new Date(item.openedAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {item.status === 'open' ? 'Aberta — resultado parcial' : 'Encerrada'}</p>
          <p className="text-sm">{formatCount(item.overview.submittedCount, 'correção concluída', 'correções concluídas')} de {formatCount(item.overview.participantCount, 'participante', 'participantes')} · {formatCount(item.overview.pendingCount, 'correção pendente', 'correções pendentes')}</p>
          <p className="text-sm">Média das correções: {item.overview.meanPercentage == null ? 'Sem correções concluídas' : `${Number(item.overview.meanPercentage).toLocaleString('pt-BR')}%`}</p>
        </div><button className="btn-outline" type="button" onClick={event => { if (onSelect(item.id) !== false) event.currentTarget.closest('[data-pedagogical-period]').open = false; }} aria-label={`Ver avaliação: ${item.title}`}>Ver avaliação</button>
      </li>)}</ul>
      {data.pagination.totalPages > 1 && <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <button className="btn-outline" disabled={changed || data.pagination.page <= 1} onClick={() => consult({ ...query, page: data.pagination.page - 1 })}>Anterior</button>
        <span>Página {data.pagination.page} de {data.pagination.totalPages}</span>
        <button className="btn-outline" disabled={changed || data.pagination.page >= data.pagination.totalPages} onClick={() => consult({ ...query, page: data.pagination.page + 1 })}>Próxima</button>
      </div>}
    </div>}
  </details>{copy?.classId === classId && <PedagogicalPeriodCopy key={`${copy.classId}:${copy.start}:${copy.end}`} {...copy} onClose={() => setCopy(null)} />}</>;
}
