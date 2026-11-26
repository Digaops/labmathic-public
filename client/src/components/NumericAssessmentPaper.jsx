import { useCallback, useEffect, useRef, useState } from 'react';
import AssessmentDialog from './AssessmentDialog';
import api from '../services/api';
import { createNumericAssessmentPrintPreview, parseNumericAssessmentPaper } from '../services/numericAssessmentPaper.mjs';

export default function NumericAssessmentPaper({ schoolClass, assignment, onClose }) {
  const [paper, setPaper] = useState(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [printing, setPrinting] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState('');
  const request = useRef(null), preview = useRef(null), alert = useRef(null);
  const endpoint = `/classes/${schoolClass.id}/assessments/${assignment.id}/numeric-paper`;
  const cancel = useCallback(() => { request.current?.abort(); preview.current?.close(); preview.current = null; }, []);
  const reload = useCallback(async () => {
    cancel(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setPrinting(false); setPaper(null); setConfirmed(false); setError(''); setMessage('');
    try {
      const { data } = await api.get(endpoint, { signal: controller.signal, timeout: 15000 });
      if (!controller.signal.aborted) setPaper(parseNumericAssessmentPaper(data, { classId: schoolClass.id, assessmentId: assignment.id, audience: 'student' }));
    } catch (failure) { if (!controller.signal.aborted) setError(failure.response?.data?.error || 'Não foi possível carregar a cópia. Tente atualizar.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [cancel, endpoint, schoolClass.id, assignment.id]);
  useEffect(() => { reload(); return cancel; }, [reload, cancel]);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);

  async function print(audience) {
    if (!paper || !confirmed || printing) return;
    cancel(); const controller = new AbortController(); request.current = controller;
    setPrinting(true); setError(''); setMessage('');
    let handle;
    try {
      handle = createNumericAssessmentPrintPreview(); preview.current = handle;
      const { data } = await api.post(`${endpoint}/print`, { audience, confirmed: true,
        expectedRevision: paper.assessment.revision, expectedFingerprint: paper.fingerprint }, { signal: controller.signal, timeout: 15000 });
      if (controller.signal.aborted) { handle.close(); return; }
      handle.render(data, { classId: schoolClass.id, assessmentId: assignment.id, audience,
        revision: paper.assessment.revision, fingerprint: paper.fingerprint });
      setMessage(audience === 'student' ? 'Cópia sem gabarito preparada em outra janela.' : 'Gabarito preparado em outra janela. Guarde apenas para você.');
    } catch (failure) {
      handle?.close();
      if (!controller.signal.aborted) {
        setConfirmed(false);
        if (failure.response?.status === 409) setPaper(null);
        setError(failure.message === 'numeric_popup_blocked' ? 'Permita a abertura de uma nova janela para este site e tente novamente.'
          : failure.response?.data?.error || 'Não foi possível preparar a cópia. Confira a prévia e tente novamente.');
      }
    } finally { if (!controller.signal.aborted) setPrinting(false); }
  }

  return <AssessmentDialog title="Atividade em papel" onClose={() => { cancel(); onClose(); }}>
    <div className="space-y-3 p-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">Imprima todas as questões desta aplicação. A cópia dos estudantes não contém respostas; o gabarito fica separado.</p>
      {error && <p ref={alert} tabIndex={-1} role="alert" className="rounded-lg border border-rose-300 p-3 text-sm text-rose-800 outline-none dark:border-rose-400/30 dark:text-rose-200">{error}</p>}
      {message && <p role="status" className="text-sm text-cyan-800 dark:text-cyan-200">{message}</p>}
      <div className="flex flex-wrap items-start justify-between gap-2">
        {paper && <div className="min-w-0 flex-1"><h3 className="break-words font-bold">{paper.assessment.title}</h3><p className="text-sm">{paper.items.length} {paper.items.length === 1 ? 'questão' : 'questões'} · {paper.schoolClass.name}</p></div>}
        <button type="button" className="btn-outline" disabled={loading || printing} onClick={reload}>Atualizar prévia</button>
      </div>
      {loading && <p role="status">Carregando questões…</p>}
      {paper && <>
        {paper.assessment.instructions && <p className="whitespace-pre-wrap break-words text-sm">{paper.assessment.instructions}</p>}
        <p className="text-sm text-slate-600 dark:text-slate-300">Imprimir não abre a atividade nem registra respostas.</p>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-slate-300 p-3 text-sm dark:border-white/20">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" disabled={printing} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          Conferi as questões e vou entregar aos estudantes apenas a cópia sem gabarito.
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={!confirmed || printing} onClick={() => print('student')}>Imprimir atividade sem gabarito</button>
          <button type="button" className="btn-outline" disabled={!confirmed || printing} onClick={() => print('teacher')}>Preparar gabarito do professor</button>
        </div>
        {printing && <p role="status">Conferindo a versão salva e preparando a cópia…</p>}
        <ol className="space-y-3" aria-label="Questões da cópia do estudante">
          {paper.items.map(item => <li key={item.number} className="rounded-xl border border-slate-200 p-3 dark:border-white/15">
            <h4 className="break-words text-sm font-bold">Questão {item.number} · {item.code}</h4>
            {item.supportText && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.supportText}</p>}
            <p className="mt-2 whitespace-pre-wrap break-words">{item.statement}</p>
            {item.unit && <p className="mt-2 break-words text-sm">Unidade da resposta: {item.unit}</p>}
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">Habilidade: {item.skillCode}</p>
          </li>)}
        </ol>
        <details className="rounded-lg border border-slate-200 p-3 text-sm dark:border-white/15">
          <summary className="min-h-11 cursor-pointer font-semibold">Como registrar as respostas depois</summary>
          <p className="mt-2">Depois de aplicar em papel, use “Corrigir e analisar resultados” na turma. Se a aplicação ainda estiver em rascunho, abra-a primeiro. Não é preciso gerar códigos de acesso para digitar as respostas.</p>
          <p className="mt-2">Confira o código de cada questão ao digitar{paper.assessment.randomizeQuestions ? ': a ordem on-line pode ser diferente' : ''}. Uma tentativa já iniciada pelo estudante on-line não pode ser substituída pelo professor.</p>
        </details>
      </>}
    </div>
  </AssessmentDialog>;
}
