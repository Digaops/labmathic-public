import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, CheckCircle2, Copy, KeyRound, Printer, RefreshCw, Search } from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import AssessmentDialog from './AssessmentDialog';
import { formatCount } from '../utils/pluralize';
import useMaterialAction from '../hooks/useMaterialAction';
import { matchesAssessmentText } from '../services/assessmentView.mjs';
import { parseStudentAccess, canIssueStudentCode, retainActiveCodes, mergeIssuedCodes } from '../services/studentAssessmentView.mjs';

const resultModes = [
  {
    value: 'score_after_close',
    label: 'Após o encerramento',
    helper: 'Evita compartilhar resultados enquanto outros estudantes ainda respondem.',
  },
  {
    value: 'score_after_submit',
    label: 'Logo após o envio',
    helper: 'Mostra somente a pontuação; o gabarito não é exibido.',
  },
  {
    value: 'hidden',
    label: 'Somente para o professor',
    helper: 'O estudante vê apenas a confirmação de entrega.',
  },
];

const credentialLabels = {
  active: 'Código ativo',
  used: 'Respondido',
  expired: 'Expirado',
};

function safePrintCredentials({ assessment, credentials }) {
  const printWindow = window.open('', '_blank', 'width=960,height=720');
  if (!printWindow) return false;
  printWindow.opener = null;
  const { document } = printWindow;
  document.title = `Acessos - ${assessment.title}`;
  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; font-family: Arial, sans-serif; color: #102039; }
    header { margin-bottom: 20px; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    p { margin: 0; color: #52637a; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .card { break-inside: avoid; border: 1px dashed #7b8da6; border-radius: 12px; padding: 16px; }
    .name { font-size: 16px; font-weight: 700; margin-bottom: 8px; overflow-wrap: anywhere; }
    .code { font-family: Consolas, monospace; font-size: 20px; font-weight: 800; letter-spacing: 1px; color: #075985; }
    .link { margin-top: 8px; font-size: 11px; color: #52637a; word-break: break-all; }
    .note { margin-top: 10px; font-size: 11px; line-height: 1.4; color: #52637a; }
    @media screen and (max-width: 600px) { .grid { grid-template-columns: minmax(0, 1fr); } }
    @media print { body { padding: 12mm; } }
  `;
  document.head.appendChild(style);
  const header = document.createElement('header');
  const title = document.createElement('h1');
  title.textContent = assessment.title;
  const subtitle = document.createElement('p');
  subtitle.textContent = `${assessment.className} · acesso individual para resposta on-line`;
  header.append(title, subtitle);
  document.body.appendChild(header);
  const grid = document.createElement('main');
  grid.className = 'grid';
  const portalUrl = `${window.location.origin}/responder`;
  credentials.forEach((credential) => {
    const card = document.createElement('section');
    card.className = 'card';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = credential.displayName;
    const code = document.createElement('div');
    code.className = 'code';
    code.textContent = credential.code;
    const link = document.createElement('div');
    link.className = 'link';
    link.textContent = portalUrl;
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'Este código é individual. Não compartilhe. Ao entrar, o tempo da avaliação poderá começar.';
    card.append(name, code, link, note);
    grid.appendChild(card);
  });
  document.body.appendChild(grid);
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 250);
  return true;
}


export default function StudentAssessmentAccessModal(props) {
  return <AccessWorkspace key={`${props.schoolClass.id}:${props.assignment.id}`} {...props} />;
}
function AccessWorkspace({ schoolClass, assignment, onClose, onChanged }) {
  const toast = useToast();
  const generatedRef = useRef(null);
  const requestRef = useRef(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [generated, setGenerated] = useState([]);
  const [resultMode, setResultMode] = useState('score_after_close');
  const [search, setSearch] = useState('');
  const action = useMaterialAction();
  const saving = action.busy;
  const basePath = `/classes/${schoolClass.id}/assessments/${assignment.id}/student-access`;
  const accept = useCallback(value => {
    const access = parseStudentAccess(value);
    setData(access); setResultMode(access.assessment.studentResultMode);
    setGenerated(current => retainActiveCodes(current, access));
    return access;
  }, []);
  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setLoading(true); setReadError('');
    try {
      const response = await api.get(basePath, { signal: controller.signal, timeout: 15000 });
      if (!controller.signal.aborted) accept(response.data);
    } catch {
      if (!controller.signal.aborted) setReadError('Não foi possível conferir os acessos. Tente novamente antes de fazer alterações.');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [basePath, accept]);
  useEffect(() => { load(); return () => requestRef.current?.abort(); }, [load]);
  useEffect(() => {
    if (!generated.length) return undefined;
    const frame = window.requestAnimationFrame(() => {
      generatedRef.current?.scrollIntoView({ block: 'start' });
      generatedRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [generated]);

  function handleClose() {
    if (saving) return;
    if (generated.length > 0 && !window.confirm('Os códigos não serão exibidos novamente. Já imprimiu ou distribuiu os acessos?')) return;
    onClose();
  }
  function run(write, message, affectedIds = []) {
    if (loading || readError || !data) return;
    setWriteError('');
    action.run(write, {
      message,
      refresh: () => { void load(); void onChanged?.(); },
      onError: failure => {
        // An uncertain renewal/revocation must not leave old cards available to print.
        setGenerated(current => current.filter(c => !affectedIds.includes(c.id)));
        setWriteError(failure + (affectedIds.length ? ' Confira a situação antes de gerar outro código. Códigos novos cuja resposta se perdeu não podem ser recuperados.' : ''));
      },
    });
  }
  function updateSettings(enabled) {
    if (enabled !== data.assessment.studentAccessEnabled && !window.confirm(enabled
      ? 'Permitir novamente a entrada dos estudantes com os códigos ativos?'
      : 'Bloquear a entrada e o uso dos códigos desta aplicação? As respostas já salvas serão preservadas.')) return;
    run(async () => accept((await api.patch(basePath, {
      expectedRevision: data.assessment.revision, enabled, resultMode,
    }, { timeout: 15000 })).data), enabled ? 'Acesso on-line atualizado.' : 'Acesso on-line atualizado; novas entradas bloqueadas.');
  }
  function generateCredentials(participantIds) {
    const ids = participantIds || data.participants.filter(canIssueStudentCode).map(p => p.id);
    if (!ids.length) return;
    const replaces = data.participants.some(p => ids.includes(p.id) && p.credential?.status === 'active');
    const message = (replaces ? 'Os códigos atuais dos estudantes selecionados deixarão de funcionar. ' : '')
      + (generated.length ? 'Confira se já guardou os cartões mostrados nesta janela. ' : '')
      + 'Os novos códigos serão mostrados uma única vez e a resposta on-line será liberada. Gerar agora?';
    if (!window.confirm(message)) return;
    run(async () => {
      const response = (await api.post(`${basePath}/credentials`, {
        expectedRevision: data.assessment.revision, confirmation: 'GERAR_ACESSOS',
        ...(participantIds ? { participantIds } : {}),
      }, { timeout: 15000 })).data;
      const codes = mergeIssuedCodes(generated, response);
      accept(response.access); setGenerated(codes);
      if (response.skipped?.length) setWriteError('Alguns estudantes não receberam outro código: já entregaram, foram dispensados ou têm respostas sendo lançadas pelo professor.');
    }, 'Códigos gerados. Guarde os cartões antes de fechar.', ids);
  }
  function revoke(participant) {
    if (!participant.credential || !window.confirm(`Revogar o código de ${participant.displayName}? Ele deixará de funcionar. As respostas já salvas serão preservadas.`)) return;
    run(async () => {
      await api.post(`${basePath}/participants/${participant.id}/revoke`, {
        expectedRevision: participant.credential.revision,
      }, { timeout: 15000 });
      setGenerated(current => current.filter(c => c.id !== participant.id));
    }, 'Código revogado.', [participant.id]);
  }
  async function copyPortalLink() {
    try { await navigator.clipboard.writeText(`${window.location.origin}/responder`); toast.success('Link copiado. Entregue o código individual separadamente.'); }
    catch { setWriteError('Não foi possível copiar. Selecione e copie o endereço mostrado em Como entregar os acessos.'); }
  }
  function printCredentials() {
    if (!safePrintCredentials({ assessment: data.assessment, credentials: generated }))
      setWriteError('O navegador bloqueou a impressão. Permita a abertura de janelas e tente novamente. Os códigos continuam nesta tela.');
  }

  const resultModeLocked = ['open', 'closed', 'cancelled'].includes(data?.assessment.status);
  const canGenerate = ['scheduled', 'open'].includes(data?.assessment.status);
  const eligible = data?.participants.filter(canIssueStudentCode).length || 0;
  const disabled = saving || loading || Boolean(readError);
  const participantRows = useMemo(() => (data?.participants || []).filter(p => matchesAssessmentText(p.displayName, search)), [data, search]);
  return <AssessmentDialog title="Acessos dos estudantes" onClose={handleClose} closeDisabled={saving} wide>
    <div data-student-access className="space-y-3 p-3 sm:p-4">
      <p className="break-words text-sm text-slate-600 dark:text-slate-300">{assignment.title}</p>
      {loading && <p role="status" className="flex items-center gap-2 text-sm"><RefreshCw size={16} className="animate-spin" /> Conferindo acessos…</p>}
      {readError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200"><p>{readError}</p><button type="button" className="btn-outline mt-2" onClick={load}>Tentar novamente</button></div>}
      {writeError && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-100">{writeError}</p>}
      {data && <>
        {generated.length > 0 && <section ref={generatedRef} tabIndex={-1} aria-live="polite" aria-label="Códigos de acesso gerados" className="scroll-mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-400/30 dark:bg-amber-400/10">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><h3 className="font-bold">Guarde os códigos antes de fechar</h3><p className="mt-1 text-sm">São mostrados somente agora. Entregue cada código apenas ao estudante correspondente.</p></div>
            <button type="button" className="btn-primary" disabled={disabled} onClick={printCredentials}><Printer size={16} /> Imprimir cartões</button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">{generated.map(c => <div key={c.id} data-generated-code className="min-w-0 rounded-xl border border-amber-200 bg-white p-3 dark:border-amber-400/20 dark:bg-[#0D192B]">
            <p className="break-words text-sm font-bold">{c.displayName}</p><code aria-label={`Código completo de ${c.displayName}`} className="mt-1 block select-all break-all font-mono text-base font-bold text-cyan-800 dark:text-cyan-200">{c.code}</code>
          </div>)}</div>
        </section>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">{formatCount(data.participants.filter(p => p.participantStatus !== 'exempted').length, 'participante', 'participantes')} · {formatCount(data.participants.filter(p => p.participantStatus === 'exempted').length, 'dispensado', 'dispensados')} · {formatCount(data.summary.activeCredentialCount, 'código ativo', 'códigos ativos')} · {formatCount(data.summary.submittedCount, 'entrega', 'entregas')}</p>
          {canGenerate && <button type="button" className="btn-primary" disabled={disabled || !eligible} onClick={() => generateCredentials()}><KeyRound size={16} /> {data.summary.activeCredentialCount ? 'Renovar todos os códigos' : 'Gerar acessos'}</button>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={data.assessment.studentAccessEnabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-200'}>{data.assessment.studentAccessEnabled ? 'Resposta on-line liberada' : 'Resposta on-line bloqueada'}</span>
          {data.assessment.studentAccessEnabled && data.assessment.status !== 'cancelled' && <button type="button" className="btn-outline" disabled={disabled} onClick={() => updateSettings(false)}><Ban size={16} /> Bloquear acessos</button>}
          {!data.assessment.studentAccessEnabled && canGenerate && data.summary.activeCredentialCount > 0 && <button type="button" className="btn-outline" disabled={disabled} onClick={() => updateSettings(true)}><CheckCircle2 size={16} /> Reabrir acessos</button>}
          <button type="button" className="btn-outline" disabled={saving || loading} onClick={load}><RefreshCw size={16} /> Atualizar situação</button>
        </div>
        {!canGenerate && <p className="text-sm text-slate-600 dark:text-slate-300">{data.assessment.status === 'draft' ? 'Para gerar os códigos, feche esta janela e use Disponibilizar para abrir ou agendar a aplicação.' : 'Esta aplicação não permite gerar novos códigos. As entregas existentes continuam preservadas.'}</p>}
        <details className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <summary className="cursor-pointer font-bold">Como entregar os acessos e mostrar resultados</summary>
          <div className="mt-2 grid gap-4 lg:grid-cols-2">
            <div className="min-w-0"><p className="text-sm leading-relaxed">Gere os códigos, imprima os cartões e entregue um a cada estudante. Eles entram pelo endereço abaixo, sem criar uma conta. Se houver tempo limite, ele começa no primeiro acesso.</p><p className="mt-2 select-all break-all text-sm">{window.location.origin}/responder</p><button type="button" className="btn-outline mt-2" onClick={copyPortalLink}><Copy size={16} /> Copiar link</button><p className="mt-2 text-sm">{data.summary.accessedCount} estudantes já acessaram. Confira as entregas em Corrigir e analisar resultados.</p></div>
            <fieldset disabled={disabled || resultModeLocked} className="min-w-0"><legend className="font-bold">Quando o estudante verá a pontuação?</legend>
              {resultModes.map(mode => <label key={mode.value} className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 p-3 dark:border-white/10"><input type="radio" name="result-mode" value={mode.value} checked={resultMode === mode.value} onChange={() => setResultMode(mode.value)} /><span className="min-w-0"><strong className="text-sm">{mode.label}</strong><span className="mt-1 block text-xs leading-relaxed text-slate-600 dark:text-slate-300">{mode.helper}</span></span></label>)}
              {!resultModeLocked && resultMode !== data.assessment.studentResultMode && <button type="button" className="btn-outline mt-2" onClick={() => updateSettings(data.assessment.studentAccessEnabled)}>Salvar escolha</button>}
            </fieldset>
            {resultModeLocked && <p className="text-sm text-slate-600 dark:text-slate-300 lg:col-start-2">Esta escolha não pode mudar depois da abertura ou do cancelamento da aplicação.</p>}
          </div>
        </details>
        <section aria-label="Estudantes e códigos">
          {data.participants.length > 5 && <label className="mb-3 block"><span className="mb-1 block text-sm font-bold">Buscar estudante</span><div className="relative"><Search aria-hidden="true" className="absolute left-3 top-3.5" size={16} /><input className="input pl-10" value={search} onChange={e => setSearch(e.target.value)} placeholder="Nome do estudante" /></div></label>}
          <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">
            {participantRows.map(p => <article key={p.id} data-access-participant className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1 basis-44"><h3 className="break-words text-sm font-bold">{p.displayName}</h3><p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{p.participantStatus === 'exempted' ? 'Dispensado' : p.attemptStatus === 'submitted' ? 'Avaliação entregue' : p.submissionChannel === 'teacher_entry' && p.attemptStatus === 'draft' ? 'Respostas sendo lançadas pelo professor' : p.credential ? `${credentialLabels[p.credential.status]} · final ${p.credential.hint}` : 'Sem código ativo'}</p></div>
              {canGenerate && canIssueStudentCode(p) && <button type="button" className="btn-outline" disabled={disabled} onClick={() => generateCredentials([p.id])}>{p.credential?.status === 'active' ? 'Renovar código' : 'Gerar código'}</button>}
              {p.credential && ['active', 'used'].includes(p.credential.status) && <button type="button" className="btn-outline text-rose-700 dark:text-rose-300" disabled={disabled} onClick={() => revoke(p)} aria-label={`Revogar acesso de ${p.displayName}`}><Ban size={16} /> Revogar</button>}
            </article>)}
            {!participantRows.length && <p className="p-3 text-sm">{data.participants.length ? 'Nenhum estudante encontrado para esta busca.' : 'Nenhum estudante nesta aplicação.'}</p>}
          </div>
        </section>
      </>}
    </div>
  </AssessmentDialog>;
}
