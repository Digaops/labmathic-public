import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Flag } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import api from '../services/api';
import useMaterialAction from '../hooks/useMaterialAction';
import useAccountLeave from '../hooks/useAccountLeave';
import AssessmentDialog from './AssessmentDialog';
import { materialButton as button } from './MaterialResourceState';
import { issueReasons, parseIssueReceipt } from '../services/contentIssuesView.mjs';

export default function ContentIssueButton({ targetType, targetId, targetLabel }) {
  const { user, announcementAccessId } = useAuth();
  const flags = useFeatureFlags();
  if (!flags.isEnabled('content.issue_review')) return null;
  return <IssueButton key={`${user?.id}:${user?.role}:${announcementAccessId}:${targetType}:${targetId}`} {...{ targetType, targetId, targetLabel }} />;
}
function IssueButton(props) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={button} onClick={() => setOpen(true)}><Flag size={16} aria-hidden="true" />Informar problema</button>
    {open && <IssueForm {...props} onClose={() => setOpen(false)} />}</>;
}
function IssueForm({ targetType, targetId, targetLabel, onClose }) {
  const action = useMaterialAction(), uid = useId(), operation = useRef(null);
  const [reason, setReason] = useState('content'), [description, setDescription] = useState(''), [receipt, setReceipt] = useState(null), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const dirty = !receipt && (Boolean(description.trim()) || uncertain);
  useAccountLeave(dirty, () => action.busy, 'Há um relato ainda não confirmado. Sair sem continuar o envio?');
  function close() { if (!dirty || window.confirm('Há um relato ainda não confirmado. Fechar e descartar este texto?')) onClose(); }
  function submit(event) {
    event.preventDefault(); setError('');
    const body = { targetType, targetId, reason, description: description.trim() }, serialized = JSON.stringify(body);
    if (!operation.current || operation.current.serialized !== serialized) operation.current = { serialized, key: crypto.randomUUID() };
    action.run(async () => {
      try {
        const response = await api.post('/content-issues', body, { timeout: 15000, headers: { 'Idempotency-Key': operation.current.key } });
        const saved = parseIssueReceipt(response.data); setReceipt(saved); setUncertain(false);
      } catch (e) { if (!e.response || e.response.status >= 500) setUncertain(true); throw e; }
    }, { message: 'Consulte o acompanhamento do relato.', onError: setError });
  }
  return <AssessmentDialog title="Informar problema no conteúdo" onClose={close} closeDisabled={action.busy}>
    <div className="space-y-3 p-3 text-sm sm:p-4">
      <p className="break-words font-semibold">{targetType === 'question' ? 'Questão' : 'Material'}: {targetLabel}</p>
      {receipt ? <div role="status" className="space-y-3"><p>{receipt.alreadyOpen ? 'Você já tem um relato em revisão sobre este conteúdo. Nenhum novo relato foi criado; o texto deste envio não foi acrescentado ao anterior.' : 'Relato enviado. A administração vai analisar e responder no acompanhamento.'}</p><Link className="btn-primary" to={`/problemas-no-acervo?relato=${receipt.id}`} onClick={onClose}>Acompanhar relato</Link></div>
        : <form onSubmit={submit} className="space-y-3">
          <p id={`${uid}-help`} className="text-slate-600 dark:text-slate-300">O relato é privado para você e a administração. Não informe nomes de estudantes, notas, senhas ou outros dados pessoais.</p>
          <label className="block font-semibold">O que precisa de revisão?<select className="input mt-1" value={reason} disabled={action.busy || uncertain} onChange={e => setReason(e.target.value)}>{Object.entries(issueReasons).filter(([key]) => targetType === 'question' || key !== 'answer').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="block font-semibold">Descreva o problema<textarea className="input mt-1 min-h-28" aria-describedby={`${uid}-help`} minLength={10} maxLength={2000} required value={description} disabled={action.busy || uncertain} onChange={e => setDescription(e.target.value)} placeholder="Ex.: na página 3, a imagem não aparece; ou explique a dúvida sobre o gabarito." /></label>
          <p className="text-slate-600 dark:text-slate-300">Enviar não altera o conteúdo nem avaliações já aplicadas. Você acompanha a resposta em “Problemas no acervo”.</p>
          {error && <p role="alert" className="text-amber-800 dark:text-amber-200">{error}</p>}
          {uncertain && <p role="status">O envio ainda não foi confirmado. Você pode repetir o mesmo envio com segurança ou consultar seus relatos antes de fechar.</p>}
          <div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={action.busy || description.trim().length < 10}>{action.busy ? 'Enviando…' : uncertain ? 'Conferir o mesmo envio' : 'Enviar relato'}</button><Link to="/problemas-no-acervo" className={button} onClick={action.busy ? e => e.preventDefault() : onClose}>Ver meus relatos</Link></div>
        </form>}
    </div>
  </AssessmentDialog>;
}
