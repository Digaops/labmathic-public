import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import AssessmentDialog from './AssessmentDialog';
import { parsePedagogicalPeriodCopy } from '../services/pedagogicalPeriodView.mjs';
import { createReportCsvDownload } from '../services/reportCsvDownload.mjs';
import { formatCount } from '../utils/pluralize';

const day = value => value.split('-').reverse().join('/');
export default function PedagogicalPeriodCopy({ classId, start, end, onClose }) {
  const path = `/pedagogical-cycle/classes/${encodeURIComponent(classId)}/period-report`;
  const scope = `${path}:${start}:${end}`;
  const [retry, setRetry] = useState(0), [state, setState] = useState({ loading: true });
  const [consent, setConsent] = useState(false), [download, setDownload] = useState({});
  const pending = useRef(null), saver = useRef(null), message = useRef(null);
  useEffect(() => {
    const downloads = createReportCsvDownload({ document }); saver.current = downloads;
    return () => { pending.current?.abort(); downloads.dispose(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    pending.current?.abort(); pending.current = null;
    setConsent(false); setDownload({}); setState({ scope, loading: true });
    api.get(`${path}/copy`, { params: { start, end }, signal: controller.signal, timeout: 30000 })
      .then(({ data }) => {
        const copy = parsePedagogicalPeriodCopy(data, classId, { start, end });
        if (!controller.signal.aborted) setState({ scope, data: copy });
      }).catch(error => {
        if (!controller.signal.aborted) setState({ scope, error: [409, 422].includes(error.response?.status)
          ? error.response.data.error : [401, 403, 404].includes(error.response?.status)
            ? 'Esta consulta não está disponível para esta conta.' : 'Não foi possível reunir as avaliações. Tente atualizar a conferência.' });
      });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [scope, path, start, end, classId, retry]);
  useEffect(() => {
    if (download.failed) { message.current?.focus({ preventScroll: true }); message.current?.scrollIntoView({ block: 'nearest' }); }
  }, [download]);
  const copy = state.scope === scope ? state.data : null;
  async function downloadCsv() {
    if (!copy || !consent || pending.current || download.stale) return;
    const controller = new AbortController(); pending.current = controller;
    setDownload({ busy: true });
    try {
      const response = await api.post(`${path}/export`, { start, end, expectedRevision: copy.revision, privacyConfirmed: true },
        { signal: controller.signal, timeout: 30000, responseType: 'blob' });
      if (controller.signal.aborted) return;
      saver.current.save(response, copy.revision, `avaliacoes-${start}-a-${end}.csv`);
      setDownload({ message: 'Planilha preparada. Confira o download no navegador.' });
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error.response?.status;
      const lostAccess = [401, 403, 404].includes(status);
      setConsent(false);
      if (lostAccess) setState({ scope, error: 'O acesso a esta turma mudou. Atualize para conferir.' });
      setDownload({ failed: true, stale: lostAccess || [409, 422].includes(status), message: [409, 422].includes(status)
        ? 'Os dados do período mudaram. Atualize a conferência antes de baixar.'
        : lostAccess ? 'A planilha não foi preparada porque o acesso mudou.' : 'Não foi possível preparar a planilha. Confirme novamente e tente baixar.' });
    } finally { if (pending.current === controller) pending.current = null; }
  }
  return <AssessmentDialog title="Guardar avaliações do período" onClose={onClose}>
    <div className="space-y-3 p-3 text-sm sm:p-4 [overflow-wrap:anywhere]" data-period-copy>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>De {day(start)} a {day(end)} · abertura em Brasília</p>
        <button type="button" className="btn-outline min-h-11" disabled={state.loading || download.busy} onClick={() => setRetry(value => value + 1)}>Atualizar conferência</button>
      </div>
      {state.loading && <p role="status">Reunindo todas as avaliações do período…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {copy && <>
        <header><h3 className="text-base font-bold">{copy.class.name} · {copy.class.academicYear}</h3>
          <p>{copy.class.gradeName}{copy.class.status === 'archived' && ' · Turma arquivada'} · {formatCount(copy.total, 'avaliação', 'avaliações')}</p>
          <p>{copy.class.institution.school || 'Escola não informada ou consulta indisponível'}{copy.class.institution.municipality && ` · ${copy.class.institution.municipality}`}</p>
        </header>
        <section aria-label="Baixar planilha" className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-white/10">
          <p>Todas as páginas do período · uma linha por avaliação. Confira títulos e nomes antes de compartilhar.</p>
          <div className="flex flex-col gap-x-3 gap-y-1 sm:flex-row sm:items-center">
            <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 py-2"><input className="mt-1 h-4 w-4 shrink-0" type="checkbox" checked={consent} disabled={download.busy || download.stale} onChange={event => setConsent(event.target.checked)} /><span>Conferi os dados e quem pode receber a planilha.</span></label>
            <button type="button" className="btn-primary min-h-11" disabled={!consent || download.busy || download.stale} onClick={downloadCsv}>{download.busy ? 'Preparando planilha…' : 'Baixar planilha (CSV)'}</button>
          </div>
        </section>
      </>}
      {download.message && <p ref={message} tabIndex={-1} role={download.failed ? 'alert' : 'status'}>{download.message}</p>}
      {copy && <>
        <details><summary className="cursor-pointer font-semibold">Como usar e compartilhar a planilha?</summary>
          <p className="mt-2">Conferido em {new Date(copy.generatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasília).</p>
          <p className="mt-2">{copy.notice}</p><p className="mt-2">A média usa apenas correções concluídas. Pendentes não são nota zero. Dispensados não entram nos participantes nem na média.</p>
          <p className="mt-2">{copy.privacyNotice}</p>
          <p className="mt-2">Abre no Excel ou LibreOffice. Se as colunas não separarem, importe como CSV UTF-8, separado por vírgula.</p>
        </details>
        <ul className="divide-y divide-neutral-200 dark:divide-white/10" aria-label="Avaliações incluídas na planilha">{copy.assessments.map(item => <li key={item.id} className="space-y-1 py-3">
          <h3 className="font-semibold">{item.title}</h3>
          <p>{new Date(item.openedAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {item.status === 'open' ? 'Aberta — resultado parcial' : 'Encerrada'} · {formatCount(item.questionCount, 'questão', 'questões')}</p>
          <p>{formatCount(item.overview.submittedCount, 'correção concluída', 'correções concluídas')} de {formatCount(item.overview.participantCount, 'participante', 'participantes')} · {formatCount(item.overview.pendingCount, 'pendente', 'pendentes')} · {formatCount(item.overview.exemptedCount, 'dispensado', 'dispensados')}</p>
          <p>Média das correções: {item.overview.meanPercentage === null ? 'Sem correções concluídas' : `${item.overview.meanPercentage.toLocaleString('pt-BR')}%`}</p>
        </li>)}</ul>
      </>}
    </div>
  </AssessmentDialog>;
}
