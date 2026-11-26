import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Sparkles, Check, ArrowRight } from 'lucide-react';
import api from '../services/api';
import { aiInput, aiReviewChecks, aiStatusText, parseAiBootstrap, editAiInput, aiBriefError } from '../services/aiAuthoringView.mjs';

export default function QuestionAiAssistant({ original, session, onBack, onApply, onDirty }) {
  const [input, setInput] = useState(() => session.getDraft(aiInput(original)));
  const [catalog, setCatalog] = useState(null), [localError, setLocalError] = useState('');
  const { result, busy, checking, uncertain, error: requestError } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const error = localError || requestError, working = busy || checking;
  const [checks, setChecks] = useState({}), [reload, setReload] = useState(0);
  const alive = useRef(true), title = useRef(null);
  useEffect(() => { alive.current = true; title.current?.focus(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setChecks({});
    title.current?.focus(); title.current?.scrollIntoView({ block: 'nearest' });
  }, [result?.id, result?.status]);
  useEffect(() => {
    const read = new AbortController(); setLocalError('');
    api.get('/question-bank/ai-authoring', { signal: read.signal, timeout: 15000 })
      .then(({ data }) => { if (!read.signal.aborted) setCatalog(parseAiBootstrap(data)); })
      .catch(() => { if (!read.signal.aborted) setLocalError('Não foi possível carregar a ajuda de IA. Seu editor continua disponível.'); });
    return () => read.abort();
  }, [reload]);
  const curriculum = catalog?.curriculum;
  const skills = curriculum?.skills.filter(s => s.grade_id === Number(input.gradeId) && s.unit_id === Number(input.unitId)) || [];
  const units = curriculum?.units.filter(u => curriculum.skills.some(s => s.grade_id === Number(input.gradeId) && s.unit_id === u.id)) || [];
  const chosen = skills.find(s => s.id === input.skillIds[0]);
  const edit = patch => {
    const next = editAiInput(input, patch);
    if (session.setDraft(next)) { onDirty(); setInput(next); setLocalError(''); }
  };
  async function send() {
    if (working || !catalog?.available) return;
    const invalid = aiBriefError(input, catalog);
    if (invalid) { setLocalError(invalid); return; }
    setLocalError(''); onDirty(); await session.send(input);
  }
  async function refreshRequest(options) {
    setLocalError(''); await session.refresh(options);
  }
  async function apply() {
    if (working || !Object.keys(aiReviewChecks).every(k => checks[k])) return;
    setLocalError('');
    try {
      const data = await session.review(checks);
      if (alive.current && data) onApply(data);
    } catch { if (alive.current) setLocalError('Não foi possível levar a sugestão ao editor. Seu texto foi preservado.'); }
  }
  function newRequest() {
    const next = editAiInput(input, { privacyConfirmed: false });
    if (session.setDraft(next)) {
      onDirty(); setInput(next); setLocalError(''); setCatalog(null); setReload(n => n + 1);
    }
  }
  return <div data-ai-authoring className="space-y-4 p-3 sm:p-4">
    <header className="flex items-start justify-between gap-3">
      <div><h3 ref={title} tabIndex={-1} className="flex items-center gap-2 text-lg font-bold outline-none"><Sparkles size={20} className="text-teal-700 dark:text-cyan-300" />Ajuda para criar uma questão</h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{result?.status === 'succeeded' ? '2. Confira a sugestão antes de levar ao editor.' : '1. Escolha o que a questão precisa trabalhar.'}</p></div>
      <button type="button" className="btn-outline shrink-0" onClick={onBack} disabled={working}><ArrowLeft size={16} />Editor</button>
    </header>
    {error && <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100">{error}</div>}
    {!catalog && <div className="flex items-center gap-3 text-sm"><p role="status">{error ? 'A ajuda está indisponível.' : 'Carregando anos e habilidades…'}</p>{error && <button type="button" className="btn-outline" onClick={() => setReload(n => n + 1)}>Tentar novamente</button>}</div>}
    {catalog && !catalog.available && <p role="status" className="rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800">A geração por IA ainda não está liberada neste ambiente. Você pode conferir as opções abaixo e continuar pelo editor. Não será exibida uma resposta de exemplo como se fosse gerada.</p>}
    {catalog && !result && <>
      <fieldset disabled={working || uncertain} className="space-y-3">
        <legend className="sr-only">Pedido de ajuda</legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de ajuda">{[['new_question','Criar uma sugestão'],['complement','Melhorar meu texto']].map(([value,label]) => <button key={value} type="button" aria-pressed={input.mode === value} onClick={() => edit({ mode: value })} className={'btn-outline ' + (input.mode === value ? '!border-teal-600 !bg-teal-50 !text-teal-900 dark:!border-cyan-300 dark:!bg-cyan-900/40 dark:!text-cyan-100' : '')}>{label}</button>)}</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_7rem_1.2fr]">
          <label><span className="label">Ano escolar</span><select aria-label="Ano escolar para a IA" className="input" value={input.gradeId} onChange={e => edit({ gradeId: Number(e.target.value), unitId: '', skillIds: [] })}><option value="">Selecione</option>{curriculum.grades.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label><span className="label">Ano letivo</span><input aria-label="Ano letivo" type="number" min="2000" max="2100" className="input" value={input.academicYear} onChange={e => edit({ academicYear: Number(e.target.value) })} /></label>
          <label className="col-span-2 sm:col-span-1"><span className="label">Unidade temática</span><select aria-label="Unidade temática para a IA" disabled={!input.gradeId} className="input" value={input.unitId} onChange={e => edit({ unitId: Number(e.target.value), skillIds: [] })}><option value="">Selecione</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        </div>
        <label className="block"><span className="label">Habilidade BNCC</span><select aria-label="Habilidade BNCC para a IA" aria-describedby="ai-skill-help" disabled={!input.unitId} className="input" value={input.skillIds[0] || ''} onChange={e => edit({ skillIds: e.target.value ? [Number(e.target.value)] : [] })}><option value="">Selecione a habilidade</option>{skills.map(s => <option key={s.id} value={s.id}>{s.code}</option>)}</select></label>
        <p id="ai-skill-help" className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{chosen?.description || 'O ano escolar e a unidade definem as habilidades disponíveis. Nesta etapa, trabalhamos uma habilidade de matemática por questão.'}</p>
        <label className="block"><span className="label">{input.mode === 'complement' ? 'Seu texto para melhorar' : 'O que você quer trabalhar? (opcional)'}</span><textarea aria-label="Orientações para a questão" className="input min-h-24" value={input.teacherText} onChange={e => edit({ teacherText: e.target.value })} maxLength={4000} placeholder="Ex.: uma situação com divisão de materiais entre grupos." /><span className="text-xs text-slate-500 dark:text-slate-400">{input.teacherText.length}/4000 · Envie somente conteúdo pedagógico, sem nomes, contatos, notas ou dados de alunos.</span></label>
        <label className="flex min-h-11 items-start gap-3 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800"><input className="mt-1" type="checkbox" checked={input.privacyConfirmed} onChange={e => edit({ privacyConfirmed: e.target.checked })} /><span>Conferi que o texto não tem dados pessoais. Autorizo enviar somente este pedido pedagógico à OpenAI para obter uma sugestão.</span></label>
        <p className="text-xs text-slate-600 dark:text-slate-300">A IA pode errar. Nada será salvo como questão ou enviado aos estudantes sem sua ação. Geração de imagens não está incluída nesta etapa.</p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        {uncertain ? <><button type="button" className="btn-outline" disabled={working} onClick={() => refreshRequest()}>Conferir este pedido</button><button type="button" className="btn-outline" disabled={working} onClick={send}>Reenviar o mesmo pedido</button></>
          : <button type="button" className="btn-primary" disabled={working || !catalog.available || !chosen || !input.privacyConfirmed || (input.mode === 'complement' && !input.teacherText.trim()) || input.teacherText.length > 4000} onClick={send}><Sparkles size={16} />{busy ? 'Preparando sugestão…' : 'Pedir uma sugestão'}</button>}
        {busy && <button type="button" className="btn-outline" disabled={checking} onClick={() => refreshRequest({ cancel: true })}>Interromper pedido</button>}
        {!working && !uncertain && catalog.latest && <button type="button" className="btn-outline" onClick={() => refreshRequest({ resumeId: catalog.latest.id })}>Retomar último pedido</button>}
      </div>
      {busy && <p role="status" className="text-sm">Pode levar até 45 segundos. Não é necessário clicar novamente.</p>}
    </>}
    {checking && <p role="status" className="text-sm">Conferindo este pedido…</p>}
    {result && result.status !== 'succeeded' && <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700"><p role="status" className="text-sm">{aiStatusText(result)}</p><div className="flex flex-wrap gap-2"><button type="button" className="btn-outline" disabled={checking} onClick={() => refreshRequest()}>Conferir pedido</button>{result.status === 'processing' ? <button type="button" className="btn-outline" disabled={checking} onClick={() => refreshRequest({ cancel: true })}>Interromper pedido</button> : <button type="button" className="btn-outline" disabled={working} onClick={newRequest}>Preparar outro pedido</button>}</div></div>}
    {result?.status === 'succeeded' && <>
      <p role="status" className="sr-only">Sugestão pronta. Confira o enunciado, a resposta e as três confirmações antes de levar ao editor.</p>
      <div className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm dark:border-cyan-500/30 dark:bg-cyan-950/30"><strong>Sugestão para revisar · {result.brief.skills[0].code}</strong><p className="mt-1">{result.brief.grade.name} · {result.brief.unit.name} · ano letivo {result.brief.academicYear}</p><p className="mt-2">{result.brief.skills[0].description}</p></div>
      <div className="grid items-start gap-4 md:grid-cols-2">
        <section aria-label="Sugestão da IA" className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700 md:order-2"><h4 className="font-bold">Confira a questão e a resposta</h4><p className="whitespace-pre-wrap text-sm leading-relaxed">{result.suggestion.statement}</p>
          <ol className="space-y-2 text-sm">{result.suggestion.options.map((o,i) => <li key={i} className={'rounded-lg border p-3 ' + (o.correct ? 'border-teal-300 bg-teal-50 dark:border-cyan-500/30 dark:bg-cyan-950/30' : 'border-slate-200 dark:border-slate-700')}><strong>{'ABCD'[i]}.</strong> {o.text}{o.correct && <span className="mt-1 flex items-center gap-1 font-semibold"><Check size={14} />Resposta proposta pela IA</span>}</li>)}</ol>
          <h5 className="font-semibold">Resolução proposta</h5><p className="whitespace-pre-wrap text-sm leading-relaxed">{result.suggestion.explanation}</p>
        </section>
        <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-700 md:order-1"><h4 className="font-bold">Seu pedido original</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{result.brief.teacherText || 'Criar uma questão a partir da habilidade selecionada.'}</p><p className="mt-3 text-xs text-slate-500 dark:text-slate-400">A sugestão só vai para o editor quando você confirmar.</p></section>
      </div>
      <fieldset disabled={working} className="space-y-2"><legend className="mb-2 font-bold">Antes de aproveitar</legend>{Object.entries(aiReviewChecks).map(([key,label]) => <label key={key} className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"><input type="checkbox" checked={checks[key] || false} onChange={e => setChecks(current => ({ ...current, [key]: e.target.checked }))} />{label}</label>)}</fieldset>
      <div className="flex flex-wrap gap-2"><button type="button" className="btn-primary" disabled={working || !Object.keys(aiReviewChecks).every(k => checks[k])} onClick={apply}><ArrowRight size={16} />Levar sugestão ao editor</button><button type="button" className="btn-outline" disabled={working} onClick={onBack}>Manter meu texto</button><button type="button" className="btn-outline" disabled={working} onClick={newRequest}>Preparar outro pedido</button></div>
      <p className="text-xs text-slate-600 dark:text-slate-300">Você ainda poderá editar e escolher quando salvar. Imagens e texto de apoio existentes serão mantidos; confira se continuam adequados à nova pergunta.</p>
    </>}
  </div>;
}
