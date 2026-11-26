import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import useHomeResource from '../hooks/useHomeResource';
import AssessmentDialog from './AssessmentDialog';
import { parseBankOptions, parseBankSkills } from '../services/questionBankView.mjs';
import { decimalHint, emptyNumericDraft, numericForm, numericPayload, parseNumericDetail, parseNumericPage, parseNumericPreview, canEditNumeric, numericStatusLabels } from '../services/numericDraftView.mjs';
import { createNumericDraftPrintPreview } from '../services/numericDraftPrint.mjs';
import NumericDraftReview from './NumericDraftReview';
import NumericEditorialPanel from './NumericEditorialPanel';

const base = '/question-bank/numeric-drafts';
export default function NumericQuestionDrafts({ identity, onClose }) {
  const [page, setPage] = useState(1), [search, setSearch] = useState(''), [term, setTerm] = useState('');
  const [editing, setEditing] = useState(false), [saved, setSaved] = useState(null);
  const [form, setForm] = useState(emptyNumericDraft), [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [conflict, setConflict] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [answerTest, setAnswerTest] = useState(''), [check, setCheck] = useState('');
  const [preview, setPreview] = useState(null);
  const alive = useRef(true), lock = useRef(false), pending = useRef(null), read = useRef(null);
  const alert = useRef(null), title = useRef(null), listTitle = useRef(null);
  const printWindow = useRef(null), previewTitle = useRef(null), previewButton = useRef(null);
  const resource = useHomeResource(!editing ? `${base}?page=${page}&search=${encodeURIComponent(term)}` : null, identity, parseNumericPage);
  const grades = useHomeResource(editing && !saved ? '/question-bank/grades' : null, identity, parseBankOptions);
  const units = useHomeResource(editing && !saved && form.gradeId ? '/question-bank/units?grade_id=' + form.gradeId : null, identity, parseBankOptions);
  const skills = useHomeResource(editing && !saved && form.gradeId && form.unitId ? `/question-bank/skills?grade_id=${form.gradeId}&unit_id=${form.unitId}` : null, identity, parseBankSkills);
  const chosen = skills.data?.find(s => String(s.id) === form.skillId);
  const readOnly = saved && !canEditNumeric(saved);
  const curriculumReady = Boolean(saved) || (grades.status === 'ready' && units.status === 'ready' && skills.status === 'ready' && Boolean(chosen));
  useEffect(() => { alive.current = true; return () => { alive.current = false; read.current?.abort(); printWindow.current?.close(); }; }, []);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  useEffect(() => {
    if (!dirty && !uncertain && !busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, uncertain, busy]);
  useEffect(() => {
    if (resource.status === 'ready' && page > Math.max(1, resource.data.pagination.totalPages)) setPage(Math.max(1, resource.data.pagination.totalPages));
  }, [resource.status, resource.data, page]);
  function mayLeave() {
    return !lock.current && (!(dirty || uncertain) || window.confirm(uncertain
      ? 'O pedido pode ter sido salvo. Voltar à lista para conferir, sem repetir o envio?'
      : 'Sair sem salvar as alterações deste rascunho?'));
  }
  function close() { if (mayLeave()) onClose(); }
  function back() {
    if (!mayLeave()) return;
    read.current?.abort(); setEditing(false); setDirty(false); setUncertain(false); setConflict(false);
    pending.current = null; setError(''); setNotice(''); clearPreview();
    requestAnimationFrame(() => listTitle.current?.focus());
  }
  function fresh() {
    clearPreview();
    setForm(emptyNumericDraft()); setSaved(null); setEditing(true); setDirty(false); setUncertain(false); setConflict(false);
    setError(''); setNotice(''); setAnswerTest(''); setCheck(''); pending.current = null;
    requestAnimationFrame(() => title.current?.focus());
  }
  function change(key, value) {
    clearPreview();
    setDirty(true); setNotice(''); setCheck(''); setForm(current => ({ ...current, [key]: value,
      ...(key === 'gradeId' ? { unitId: '', skillId: '' } : key === 'unitId' ? { skillId: '' } : {}) }));
  }
  async function open(publicId) {
    if (lock.current || ((dirty || uncertain) && !mayLeave())) return;
    lock.current = true; setBusy(true); setError('');
    const controller = new AbortController(); read.current?.abort(); read.current = controller;
    try {
      const response = await api.get(`${base}/${publicId}`, { signal: controller.signal, timeout: 15000 });
      const result = parseNumericDetail(response.data);
      if (!alive.current || controller.signal.aborted) return;
      setSaved(result); setForm(numericForm(result)); setEditing(true); setDirty(false); setUncertain(false); setConflict(false);
      clearPreview();
      pending.current = null; setNotice(''); setCheck(''); setAnswerTest('');
      requestAnimationFrame(() => title.current?.focus());
    } catch {
      if (alive.current && !controller.signal.aborted) setError('Não foi possível abrir o rascunho. Tente novamente.');
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function save() {
    if (lock.current || conflict || readOnly || pending.current?.type === 'editorial') return;
    setError(''); setNotice(''); setCheck('');
    if (!pending.current) {
      try {
        if (!curriculumReady) throw new Error('Aguarde o carregamento e confirme a habilidade BNCC.');
        pending.current = { key: crypto.randomUUID(), payload: numericPayload(form, saved), publicId: saved?.publicId };
      } catch (e) { setError(e.message); return; }
    }
    lock.current = true; setBusy(true);
    const operation = pending.current;
    try {
      const options = { timeout: 15000, headers: { 'Idempotency-Key': operation.key } };
      const response = operation.publicId ? await api.patch(`${base}/${operation.publicId}`, operation.payload, options)
        : await api.post(base, operation.payload, options);
      const result = parseNumericDetail(response.data);
      if (!alive.current) return;
      setSaved(result); setForm(numericForm(result)); setDirty(false); setUncertain(false); pending.current = null;
      setNotice('Rascunho salvo. Confira a prévia e envie para revisão quando estiver pronto.');
    } catch (e) {
      if (!alive.current) return;
      if (!e.response || e.response.status >= 500) {
        setUncertain(true); setError('Não foi possível confirmar o salvamento. Use Conferir envio: o mesmo pedido será retomado, sem criar outra questão.');
      } else {
        pending.current = null; setUncertain(false); setConflict(e.response.status === 409);
        setError(e.response.data?.error || 'Não foi possível salvar. Seus campos foram preservados.');
      }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function checkAnswer() {
    if (lock.current || dirty || uncertain || conflict || !saved) return;
    lock.current = true; setBusy(true); setError(''); setNotice(''); setCheck('');
    try {
      const response = await api.post(`${base}/${saved.publicId}/check`, { expectedRevision: saved.revision, response: answerTest }, { timeout: 15000 });
      const result = response.data;
      if (typeof result.answered !== 'boolean' || typeof result.accepted !== 'boolean' || result.revision !== saved.revision) throw new Error('Resposta inválida');
      if (alive.current) setCheck(!result.answered ? 'Sem resposta. Não equivale a responder zero.' : result.accepted ? 'Resposta aceita: corresponde ao valor esperado.' : 'Resposta não aceita: o valor é diferente do esperado.');
    } catch (e) { if (alive.current) { setError(e.response?.data?.error || 'Não foi possível conferir a resposta. Tente novamente.'); if (e.response?.status === 409) setConflict(true); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function clearPreview() { printWindow.current?.close(); printWindow.current = null; setPreview(null); }
  function editAgain() {
    if (lock.current) return;
    clearPreview(); setNotice('');
    requestAnimationFrame(() => previewButton.current?.focus());
  }
  async function editorialAction(path, payload) {
    if (lock.current || dirty || conflict) return;
    if (!pending.current && !path) return;
    if (!pending.current) pending.current={type:'editorial',url:base+path,payload,key:crypto.randomUUID()};
    if (pending.current.type!=='editorial') return;
    lock.current=true;setBusy(true);setError('');setNotice('');
    try {
      const operation=pending.current;
      const response=await api.post(operation.url,operation.payload,{timeout:15000,headers:{'Idempotency-Key':operation.key}});
      const result=parseNumericDetail(response.data);
      if(!alive.current)return;
      pending.current=null;setUncertain(false);setSaved(result);setForm(numericForm(result));setDirty(false);setCheck('');clearPreview();
      setNotice('Pedido confirmado. Confira a situação atual da questão.');requestAnimationFrame(()=>title.current?.focus());
    } catch(e) {
      if(!alive.current)return;
      if(!e.response||e.response.status>=500){setUncertain(true);setError('Não foi possível confirmar o pedido. Use Conferir pedido de revisão para retomar o mesmo envio.');}
      else {pending.current=null;setUncertain(false);setConflict(e.response.status===409);setError(e.response.data?.error||'Não foi possível concluir o pedido.');}
    } finally {lock.current=false;if(alive.current)setBusy(false);}
  }
  async function reviewSaved() {
    if (lock.current || dirty || uncertain || conflict || !saved) return;
    lock.current = true; setBusy(true); setError(''); setNotice(''); setCheck('');
    const controller = new AbortController(); read.current?.abort(); read.current = controller;
    try {
      const response = await api.post(`${base}/${saved.publicId}/preview`, { expectedRevision: saved.revision }, { signal: controller.signal, timeout: 15000 });
      const result = parseNumericPreview(response.data, saved.publicId, saved.revision);
      if (!alive.current || controller.signal.aborted) return;
      setPreview(result); requestAnimationFrame(() => previewTitle.current?.focus());
    } catch (e) {
      if (alive.current && !controller.signal.aborted) { setError(e.response?.data?.error || 'Não foi possível abrir a prévia. Tente novamente.'); if (e.response?.status === 409) setConflict(true); }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function preparePrint(audience = 'teacher') {
    if (lock.current || !preview || dirty || uncertain || conflict) return;
    let handle;
    setError(''); setNotice('');
    try { printWindow.current?.close(); handle = createNumericDraftPrintPreview(); printWindow.current = handle; }
    catch { setError('O navegador não abriu a cópia. Permita pop-ups deste site e tente novamente.'); return; }
    lock.current = true; setBusy(true);
    const controller = new AbortController(); read.current?.abort(); read.current = controller;
    try {
      const response = await api.post(`${base}/${preview.draft.publicId}/print`, { expectedRevision: preview.draft.revision, expectedFingerprint: preview.fingerprint, audience }, { signal: controller.signal, timeout: 15000 });
      if (!alive.current || controller.signal.aborted) { handle.close(); return; }
      const result = parseNumericPreview(response.data, preview.draft.publicId, preview.draft.revision);
      if (result.fingerprint !== preview.fingerprint) throw new Error('numeric_preview_changed');
      handle.render(result, preview.draft.publicId, preview.draft.revision, audience);
      setNotice('Cópia preparada em outra janela. Use Imprimir / salvar PDF nessa janela.');
    } catch (e) {
      handle.close();
      if (alive.current && !controller.signal.aborted) { setError(e.response?.data?.error || 'Não foi possível preparar a cópia. Abra a prévia novamente e tente outra vez.'); if (e.response?.status === 409) setConflict(true); }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <AssessmentDialog title={editing ? 'Questão de resposta numérica' : 'Minhas questões numéricas'} onClose={close} closeDisabled={busy}>
    <div className="bank-form space-y-3 p-3 sm:p-4">
      {!preview && <p className="text-sm text-slate-600 dark:text-slate-300">Envie suas questões para revisão. Após a aprovação, use em papel ou, com o piloto liberado, em Turmas → Aplicações → Nova aplicação → Respostas numéricas.</p>}
      {error && <p ref={alert} role="alert" tabIndex={-1} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 outline-none dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100">{error}</p>}
      {!editing ? <>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 ref={listTitle} tabIndex={-1} className="font-bold outline-none">Suas questões</h3><button className="btn-primary" disabled={busy} onClick={fresh}>Criar rascunho numérico</button></div>
        <form role="search" aria-label="Buscar rascunho numérico" className="flex gap-2" onSubmit={e => { e.preventDefault(); setPage(1); setTerm(search.trim()); }}><input aria-label="Buscar rascunho" className="input min-w-0 flex-1" maxLength={100} value={search} onChange={e => setSearch(e.target.value)} placeholder="Trecho do enunciado ou código" /><button className="btn-outline" type="submit">Buscar</button></form>
        {resource.status === 'loading' ? <p role="status">Carregando rascunhos…</p> : resource.status === 'error' ? <div role="alert"><p>A consulta falhou.</p><button className="btn-outline" onClick={resource.retry}>Tentar novamente</button></div> : resource.data && <>
          <p className="text-sm">{resource.data.pagination.total} {resource.data.pagination.total === 1 ? 'questão encontrada' : 'questões encontradas'}</p>
          {!resource.data.data.length && <p className="text-sm">{term ? 'Nenhum resultado. Tente outro trecho.' : 'Crie uma pergunta que tenha um número como resposta, como uma medida ou quantidade.'}</p>}
          <div className="divide-y divide-slate-200 dark:divide-white/10">{resource.data.data.map(row => <article key={row.publicId} className="space-y-2 py-3">
            <p className="text-xs text-slate-600 dark:text-slate-300">{row.curriculum.gradeName} · {row.curriculum.skillCode} · {numericStatusLabels[row.status==='approved'?'approved':row.review?.status||'draft']}</p>
            <p className="line-clamp-3 break-words font-medium">{row.statement}</p><button className="btn-outline" disabled={busy} onClick={() => open(row.publicId)}>Abrir questão</button>
          </article>)}</div>
          {resource.data.pagination.totalPages > 1 && <nav aria-label="Páginas de rascunhos" className="flex flex-wrap items-center justify-between gap-2"><button className="btn-outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Anterior</button><span>{page} / {resource.data.pagination.totalPages}</span><button className="btn-outline" disabled={page === resource.data.pagination.totalPages} onClick={() => setPage(p => p + 1)}>Próxima</button></nav>}
        </>}
      </> : preview ? <>
        <NumericDraftReview preview={preview} headingRef={previewTitle} busy={busy} conflict={conflict}
          onEdit={editAgain} onPrint={()=>preparePrint('teacher')} onPrintStudent={()=>preparePrint('student')} onReload={() => open(saved.publicId)} />
        {notice && <p role="status" className="text-sm text-teal-800 dark:text-cyan-200">{notice}</p>}
      </> : <>
        <button className="btn-outline" disabled={busy} onClick={back}>Voltar às minhas questões</button>
        <h3 ref={title} tabIndex={-1} className="font-bold outline-none">{saved ? readOnly ? 'Consultar versão salva' : 'Editar rascunho salvo' : 'Criar rascunho'}</h3>
        {saved && <div className="flex flex-wrap items-center gap-2"><button ref={previewButton} className="btn-outline" disabled={busy || dirty || uncertain || conflict} onClick={reviewSaved}>Conferir prévia salva</button>{dirty && <p className="text-sm">Salve as alterações para atualizar a prévia.</p>}</div>}
        {saved && <NumericEditorialPanel key={`${saved.publicId}:${saved.revision}:${saved.review?.status}`} draft={saved} dirty={dirty} busy={busy} uncertain={uncertain && pending.current?.type==='editorial'} conflict={conflict}
          onAction={editorialAction} onRetry={()=>editorialAction()} onOpen={open} />}
        {[['anos escolares',grades],['unidades temáticas',units],['habilidades',skills]].filter(([,r]) => r.status === 'error').map(([label,r]) => <div role="alert" key={label}><p>Não foi possível carregar {label}.</p><button className="btn-outline" onClick={r.retry}>Recarregar {label}</button></div>)}
        <fieldset disabled={busy || uncertain || conflict || readOnly} className="space-y-3">
          {saved ? <details className="rounded-lg bg-slate-100 p-3 text-sm dark:bg-white/5"><summary className="cursor-pointer font-semibold">{saved.curriculum.gradeName} · {saved.curriculum.skillCode}</summary><p className="mt-2">{saved.curriculum.unitName} — {saved.curriculum.skillDescription}</p><p className="mt-2 text-xs">A habilidade é mantida neste rascunho. Para outra habilidade, crie uma nova questão.</p></details> : <>
            <div className="grid gap-3 sm:grid-cols-2"><label><span className="label">Ano escolar</span><select className="input" value={form.gradeId} disabled={grades.status !== 'ready'} onChange={e => change('gradeId',e.target.value)}><option value="">Selecione o ano</option>{grades.data?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label><span className="label">Unidade temática</span><select className="input" value={form.unitId} disabled={units.status !== 'ready'} onChange={e => change('unitId',e.target.value)}><option value="">Selecione a unidade</option>{units.data?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label></div>
            <label className="block"><span className="label">Habilidade BNCC</span><select className="input" value={form.skillId} disabled={skills.status !== 'ready'} onChange={e => change('skillId',e.target.value)}><option value="">Selecione a habilidade</option>{skills.data?.map(s => <option key={s.id} value={s.id}>{s.code}</option>)}</select></label>
            {chosen && <p className="text-sm">{chosen.description}</p>}
          </>}
          <label className="block"><span className="label">Enunciado</span><textarea className="input min-h-24" maxLength={10000} value={form.statement} onChange={e => change('statement',e.target.value)} placeholder="Escreva a pergunta. Deixe claro o que o estudante deve calcular." /></label>
          <details><summary className="cursor-pointer py-2 text-sm font-semibold">Texto de apoio (opcional)</summary><label><span className="label">Texto de apoio</span><textarea className="input" maxLength={10000} value={form.supportText} onChange={e => change('supportText',e.target.value)} /></label></details>
          <div className="grid gap-3 sm:grid-cols-2"><label><span className="label">Resposta esperada</span><input className="input" inputMode="decimal" aria-describedby="numeric-rule" maxLength={18} value={form.answer} onChange={e => change('answer',e.target.value)} placeholder="Ex.: 2,5" /></label><label><span className="label">Unidade da resposta (opcional)</span><input className="input" maxLength={100} value={form.unit} onChange={e => change('unit',e.target.value)} placeholder="Ex.: cm, reais, litros" /></label></div>
          <div id="numeric-rule" className="rounded-lg bg-slate-100 p-3 text-sm dark:bg-white/5"><p className="font-semibold">A resposta precisa ter o valor exato.</p><p>2,5 e 2.50 representam o mesmo valor. Um número próximo não será aceito. A unidade fica fora do campo da resposta.</p><p className="mt-1">{decimalHint}</p></div>
          <label className="block"><span className="label">Dificuldade</span><select className="input" value={form.difficulty} onChange={e => change('difficulty',e.target.value)}><option value="facil">Fácil</option><option value="media">Média</option><option value="dificil">Difícil</option></select></label>
          <label className="block"><span className="label">Como chegar à resposta</span><textarea className="input min-h-20" maxLength={5000} value={form.explanation} onChange={e => change('explanation',e.target.value)} placeholder="Explique a resolução. Necessária para enviar à revisão; não aparece na cópia do estudante." /></label>
        </fieldset>
        {conflict ? <button className="btn-outline" disabled={busy} onClick={() => saved ? open(saved.publicId) : back()}>{saved ? 'Reabrir versão salva' : 'Conferir lista de rascunhos'}</button> : !readOnly && pending.current?.type!=='editorial' && <button className="btn-primary" disabled={busy || (!uncertain && (!curriculumReady || (saved && !dirty)))} onClick={save}>{busy ? 'Aguarde…' : uncertain ? 'Conferir envio' : 'Salvar rascunho'}</button>}
        {notice && <p role="status" className="text-sm text-teal-800 dark:text-cyan-200">{notice}</p>}
        {saved && <section className="space-y-2 border-t border-slate-200 pt-3 dark:border-white/10"><h3 className="font-bold">Confira a regra de correção</h3><p className="text-sm">Teste somente a versão salva. Esta resposta de teste não é guardada e não gera nota.</p>
          {dirty && <p className="text-sm">Salve as alterações antes de conferir.</p>}
          <label className="block"><span className="label">Resposta para testar{form.unit ? ` (${form.unit})` : ''}</span><input className="input" inputMode="decimal" maxLength={18} value={answerTest} onChange={e => { setAnswerTest(e.target.value); setCheck(''); }} disabled={busy || dirty || uncertain || conflict} /></label>
          <button className="btn-outline" disabled={busy || dirty || uncertain || conflict} onClick={checkAnswer}>Conferir resposta</button>{check && <p role="status" className="text-sm font-semibold">{check}</p>}
        </section>}
      </>}
    </div>
  </AssessmentDialog>;
}
