import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, Circle, Image as ImageIcon, Plus, Save, Search, Trash2, Pencil, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import QuestionAiAssistant from './QuestionAiAssistant';
import { aiToEditor } from '../services/aiAuthoringView.mjs';
import { createAiAuthoringSession } from '../services/aiAuthoringSession.mjs';
import { useToast } from '../contexts/ToastContext';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import { imageAccept, imageUploadHint, uploadSelectionError } from '../services/uploadSelection.mjs';
import { parseBankOptions, parseBankSkills, parseBankQuestion } from '../services/questionBankView.mjs';
import { readAuthorQuery, authorSearchParams, authorRequestPath, parseAuthorPage, emptyAuthorQuestion, authorFormError, uncertainWrite } from '../services/authoringView.mjs';
import AssessmentDialog from './AssessmentDialog';
import AuthoringWriteAlert from './AuthoringWriteAlert';
import QuestionImage from './QuestionImage';
import { formatCount } from '../utils/pluralize';

const difficultyLabels = { facil: 'Fácil', media: 'Média', dificil: 'Difícil' };
const NumericQuestionDrafts = lazy(() => import('./NumericQuestionDrafts'));
const surface = 'rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31]';

export default function TeacherQuestionManager(props) {
  const { user } = useAuth();
  return <AuthorWorkspace key={user?.id} {...props} />;
}

function AuthorWorkspace({ isAdmin = false, onPrepareSet, autoOpenCreate = false, onCreateHandled }) {
  const { isEnabled } = useFeatureFlags();
  const [aiOpen, setAiOpen] = useState(false);
  const [numericOpen, setNumericOpen] = useState(false);
  const numericButton = useRef(null);
  const aiSession = useRef(null), aiButton = useRef(null), editorStatement = useRef(null);
  const { user } = useAuth(), toast = useToast();
  const [params, setParams] = useSearchParams();
  const query = readAuthorQuery(params);
  const [search, setSearch] = useState(query.search);
  const [selected, setSelected] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [form, setForm] = useState(emptyAuthorQuestion);
  const [editorOpen, setEditorOpen] = useState(false);
  const [imageFile, setImageFile] = useState(null), [imagePreview, setImagePreview] = useState('');
  const [editorError, setEditorError] = useState(''), [listError, setListError] = useState('');
  const [editorUncertain, setEditorUncertain] = useState(false);
  const [opening, setOpening] = useState(false);
  const dirty = useRef(false), trigger = useRef(null), newButton = useRef(null), heading = useRef(null);
  const editRead = useRef(null), autoHandled = useRef(false), pageFocus = useRef(false);
  const action = useMaterialAction();
  const resource = useReadOnlyResource(authorRequestPath(query), user?.id, parseAuthorPage);
  const gradeResource = useReadOnlyResource(editorOpen ? '/question-bank/grades' : null, user?.id, parseBankOptions);
  const unitResource = useReadOnlyResource(editorOpen && form.grade_id ? '/question-bank/units?grade_id=' + form.grade_id : null, user?.id, parseBankOptions);
  const skillResource = useReadOnlyResource(editorOpen && form.grade_id && form.unit_id ? '/question-bank/skills?grade_id=' + form.grade_id + '&unit_id=' + form.unit_id : null, user?.id, parseBankSkills);
  const questions = resource.data?.data || [], pagination = resource.data?.pagination;
  const chosenSkill = skillResource.data?.find(skill => String(skill.id) === String(form.skill_id));
  const categoriesReady = gradeResource.status === 'ready' && unitResource.status === 'ready' && skillResource.status === 'ready';
  const busy = action.busy;
  useEffect(() => setSearch(query.search), [query.search]);
  useEffect(() => () => editRead.current?.abort(), []);
  useEffect(() => () => aiSession.current?.dispose(), []);
  useEffect(() => () => { if (imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview); }, [imagePreview]);
  useEffect(() => {
    if (!autoOpenCreate) { autoHandled.current = false; return; }
    if (!isAdmin && !autoHandled.current) { autoHandled.current = true; openNew(); onCreateHandled?.(); }
  }, [autoOpenCreate, isAdmin, onCreateHandled]);
  useEffect(() => {
    if (resource.status === 'ready' && query.page > Math.max(1, pagination.totalPages)) {
      setParams(authorSearchParams(params, { ...query, page: Math.max(1, pagination.totalPages) }), { replace: true });
    } else if (pageFocus.current && resource.status !== 'loading') {
      pageFocus.current = false; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' });
    }
  }, [resource.status, query.page, pagination?.totalPages, params]);
  function changeQuery(patch) { setExpanded(null); setParams(authorSearchParams(params, { ...query, page: 1, ...patch })); }
  function removeSelected(id) { setSelected(current => current.filter(q => q.id !== id)); }
  function selectQuestion(q) {
    if (selected.some(item => item.id === q.id)) return removeSelected(q.id);
    if (q.status !== 'active') return;
    if (selected.length >= 100) return toast.error('Um simulado pode ter até 100 questões.');
    setSelected(current => [...current, { ...q, show_image: Boolean(q.image_path) }]);
  }
  function editField(field, value) { dirty.current = true; setForm(current => ({ ...current, [field]: value })); }
  function openNew() {
    if (busy || opening) return;
    aiSession.current?.dispose(); aiSession.current = null; setAiOpen(false);
    trigger.current = newButton.current; dirty.current = false;
    setForm(emptyAuthorQuestion()); setImageFile(null); setImagePreview(''); setEditorError(''); setEditorUncertain(false); setEditorOpen(true);
  }
  function closeEditor() {
    const aiPending = aiSession.current?.getSnapshot();
    if (busy || (dirty.current && !window.confirm(editorUncertain
      ? 'O pedido pode ter sido salvo. Fechar este formulário sem repetir o envio?'
      : aiPending?.busy || aiPending?.uncertain || aiPending?.result?.status === 'processing'
        ? 'Sair sem salvar? O pedido de IA pode continuar no servidor. Ao voltar, retome o pedido antes de gerar outra sugestão.'
        : 'Sair sem salvar as alterações desta questão?'))) return;
    aiSession.current?.dispose(); aiSession.current = null;
    setEditorOpen(false); setAiOpen(false); setImageFile(null); setImagePreview(''); setEditorError('');
    requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); else heading.current?.focus({ preventScroll: true }); });
  }
  async function openEdit(question, button) {
    if (busy || opening) return;
    trigger.current = button; setOpening(true); setListError('');
    const controller = new AbortController(); editRead.current?.abort(); editRead.current = controller;
    try {
      // The author list also includes inactive own questions; the general detail endpoint does not.
      const response = await api.get('/question-bank/author-questions?limit=50&search=' + encodeURIComponent(question.question_code), { signal: controller.signal, timeout: 15000 });
      const current = parseAuthorPage(response.data).data.find(q => q.id === question.id);
      if (!current) throw new Error('Questão não confirmada.');
      if (controller.signal.aborted) return;
      aiSession.current?.dispose(); aiSession.current = null; setAiOpen(false);
      setForm({ ...emptyAuthorQuestion(), ...current, grade_id: String(current.grade_id), unit_id: String(current.unit_id), skill_id: String(current.skill_id),
        support_text: current.support_text || '', official_explanation: current.official_explanation || '', remove_image: false });
      dirty.current = false; setImageFile(null); setImagePreview(current.image_path ? '/uploads/' + current.image_path : '');
      setEditorError(''); setEditorUncertain(false); setEditorOpen(true);
    } catch {
      if (!controller.signal.aborted) setListError('Não foi possível abrir a questão. Atualize a lista e tente novamente.');
    } finally { if (!controller.signal.aborted) setOpening(false); }
  }
  function selectImage(file) {
    const error = uploadSelectionError(file, 'image');
    if (error) return setEditorError(error);
    dirty.current = true; setImageFile(file || null); setImagePreview(file ? URL.createObjectURL(file) : '');
    setForm(current => ({ ...current, remove_image: !file && Boolean(current.image_path) }));
  }
  function saveQuestion() {
    if (busy || editorUncertain) return;
    const error = authorFormError(form);
    if (error) return setEditorError(error);
    if (!categoriesReady || !chosenSkill) return setEditorError('Confirme o ano, a unidade e a habilidade antes de salvar.');
    setEditorError('');
    const payload = new FormData();
    for (const key of ['skill_id','statement','support_text','difficulty','development_space','official_explanation']) payload.append(key, String(form[key]).trim());
    payload.append('options', JSON.stringify(form.options.map((option, index) => ({ ...option, option_text: option.option_text.trim(), is_correct: Number(option.is_correct), sort_order: index + 1 }))));
    if (imageFile) payload.append('image', imageFile);
    if (form.remove_image) payload.append('remove_image', '1');
    if (form.ai_request_id) payload.append('ai_request_id', form.ai_request_id);
    action.run(async () => {
      try {
        const response = form.id ? await api.put('/question-bank/author-questions/' + form.id, payload, { timeout: 15000 })
          : await api.post('/question-bank/author-questions', payload, { timeout: 15000 });
        parseBankQuestion(response.data);
      } catch (error) { if (uncertainWrite(error)) setEditorUncertain(true); throw error; }
    }, { refresh: resource.retry, onError: setEditorError, onSuccess: () => {
      aiSession.current?.dispose(); aiSession.current = null; setAiOpen(false);
      if (form.id) removeSelected(form.id);
      setEditorOpen(false); setImageFile(null); setImagePreview(''); dirty.current = false;
      requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    }, message: form.id ? 'Questão atualizada. Se necessário, selecione-a novamente para o simulado.' : 'Questão criada e mantida privada.' });
  }
  function deleteQuestion(q) {
    if (busy || !window.confirm('Excluir a questão ' + q.question_code + '? Esta ação não pode ser desfeita.')) return;
    setListError('');
    action.run(() => api.delete('/question-bank/author-questions/' + q.id, { timeout: 15000 }), {
      onSuccess: () => removeSelected(q.id), onError: setListError, refresh: resource.retry, message: 'Questão excluída.',
    });
  }
  return <section data-author-questions className="bank-form space-y-3 text-slate-900 dark:text-slate-100">
    <header className={surface}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{isAdmin ? 'Questões dos professores' : 'Minhas questões'}</h2>
        {!isAdmin && <button type="button" ref={newButton} aria-label="Criar questão" className="btn-primary" disabled={busy || opening} onClick={openNew}><Plus aria-hidden="true" size={17} /> Criar<span className="hidden sm:inline">questão</span></button>}
      </div>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{isAdmin ? 'Consulta das questões autorais. A autoria aparece em cada questão.' : 'Privadas: só você e a administração têm acesso.'}</p>
      {!isAdmin && isEnabled('question_bank.numeric_drafts') && <button ref={numericButton} className="btn-outline mt-2" disabled={busy || opening} onClick={() => setNumericOpen(true)}>Questões numéricas · piloto</button>}
      <form role="search" aria-label="Buscar questões autorais" className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); changeQuery({ search: search.trim() }); }}>
        <input type="search" aria-label="Buscar questão autoral" className="input min-w-0 flex-1" placeholder={isAdmin ? 'Código, enunciado ou professor' : 'Código ou enunciado'} value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn-outline shrink-0" type="submit"><Search aria-hidden="true" size={16} /> Buscar</button>
      </form>
    </header>
    {query.search && <div className="flex flex-wrap items-center gap-2 text-sm"><span>Busca: “{query.search}”</span><button type="button" className="btn-outline" onClick={() => { setSearch(''); changeQuery({ search: '' }); }}>Limpar busca</button></div>}
    {selected.length > 0 && !isAdmin && onPrepareSet && <div className={surface + ' flex flex-wrap items-center justify-between gap-2 text-sm'}>
      <strong>{formatCount(selected.length, 'questão selecionada', 'questões selecionadas')}</strong>
      <button type="button" className="btn-primary" disabled={busy} onClick={() => onPrepareSet(selected)}>Conferir e gerar simulado</button>
    </div>}
    <AuthoringWriteAlert message={listError} />
    {listError && <button type="button" className="btn-outline" disabled={busy || resource.status === 'loading'} onClick={resource.retry}>Atualizar lista</button>}
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]" aria-label="Lista de questões autorais">
      <h3 ref={heading} tabIndex={-1} className="border-b border-slate-200 p-3 text-sm font-semibold outline-none dark:border-white/10">{resource.status === 'loading' ? 'Buscando questões…' : resource.status === 'error' ? 'Não foi possível carregar suas questões' : formatCount(pagination?.total || 0, 'questão encontrada', 'questões encontradas')}</h3>
      {resource.status === 'loading' ? <p role="status" className="p-3 text-sm">Carregando questões…</p>
        : resource.status === 'error' ? <div role="alert" className="space-y-2 p-3 text-sm"><p>A consulta falhou. Suas questões selecionadas continuam nesta tela.</p><button type="button" className="btn-outline" onClick={resource.retry}>Tentar novamente</button></div>
          : !questions.length ? <div className="p-3 text-sm"><p className="font-bold">{query.search ? 'Nenhuma questão encontrada para esta busca.' : isAdmin ? 'Nenhuma questão autoral cadastrada.' : 'Você ainda não criou questões.'}</p><p className="mt-1">{query.search ? 'Tente outro termo ou limpe a busca.' : isAdmin ? 'As questões criadas pelos professores aparecerão aqui.' : 'Use Criar questão para escrever sua primeira pergunta.'}</p></div>
            : <div className="divide-y divide-slate-200 dark:divide-white/10">{questions.map(q => {
              const isSelected = selected.some(item => item.id === q.id), isExpanded = expanded === q.id;
              return <article key={q.id} data-author-question={q.id} className={'border-l-4 p-3 ' + (isSelected ? 'border-cyan-500 bg-cyan-50/50 dark:bg-cyan-400/5' : 'border-transparent')}>
                <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  <strong className="text-cyan-800 dark:text-cyan-200">{q.question_code}</strong><span>{q.grade_name} · {difficultyLabels[q.difficulty]}</span>
                  {q.status !== 'active' && <strong>Inativa</strong>}{isAdmin && <span>Autor: {q.creator_name || 'Não informado'}</span>}
                </div>
                <p className={'text-[15px] font-medium leading-relaxed ' + (isExpanded ? 'whitespace-pre-line' : 'line-clamp-3')}>{q.statement}</p>
                {q.image_path && !isExpanded && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">Imagem de apoio nos detalhes</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!isAdmin && <button type="button" className="btn-outline" disabled={busy || q.status !== 'active'} aria-pressed={isSelected} aria-label={(isSelected ? 'Remover seleção de ' : 'Selecionar ') + q.question_code} onClick={() => selectQuestion(q)}>{isSelected ? <CheckCircle aria-hidden="true" size={16} /> : <Circle aria-hidden="true" size={16} />}{isSelected ? 'Selecionada' : 'Selecionar'}</button>}
                  <button type="button" className="btn-outline" aria-expanded={isExpanded} aria-controls={'author-details-' + q.id} onClick={() => setExpanded(isExpanded ? null : q.id)}>{isExpanded ? 'Ocultar detalhes' : 'Ver questão e resposta'}</button>
                  {!isAdmin && <button type="button" className="btn-outline" disabled={busy || opening} onClick={e => openEdit(q, e.currentTarget)}><Pencil aria-hidden="true" size={16} /> Editar</button>}
                </div>
                {isExpanded && <div id={'author-details-' + q.id} className="mt-3 space-y-3 border-t border-slate-200 pt-3 text-sm dark:border-white/10">
                  {q.support_text && <section><h4 className="font-bold">Texto de apoio</h4><p className="mt-1 whitespace-pre-line">{q.support_text}</p></section>}
                  {q.image_path && <QuestionImage src={'/uploads/' + q.image_path} alt={'Imagem da questão ' + q.question_code} variant="detail" />}
                  <section><h4 className="mb-2 font-bold">Alternativas e resposta correta</h4>{q.options.map(o => <p key={o.option_label} className={'my-1 rounded-lg border border-slate-200 p-2 dark:border-white/10 ' + (Number(o.is_correct) === 1 ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100' : '')}><strong>{o.option_label}.</strong> {o.option_text}{Number(o.is_correct) === 1 && <span className="block font-semibold">Resposta correta</span>}</p>)}</section>
                  <section><h4 className="font-bold">Comentário ou resolução</h4><p className="mt-1 whitespace-pre-line">{q.official_explanation || 'Não informado.'}</p></section>
                  <p>{q.skill_code} — {q.skill_description}</p><p className="text-xs text-slate-600 dark:text-slate-300">Criada em {q.created_at && !Number.isNaN(Date.parse(q.created_at)) ? new Date(q.created_at).toLocaleDateString('pt-BR') : 'data não informada'}</p><p className="text-slate-600 dark:text-slate-300">{q.unit_name} · {formatCount(q.question_set_count || 0, 'simulado usa esta questão', 'simulados usam esta questão')}</p>
                  {!isAdmin && <button type="button" className="btn-outline" disabled={busy} onClick={() => deleteQuestion(q)}><Trash2 aria-hidden="true" size={16} /> Excluir questão</button>}
                </div>}
              </article>;
            })}</div>}
      {resource.status === 'ready' && pagination.totalPages > 1 && <nav aria-label="Páginas de questões autorais" className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 p-3 dark:border-white/10">
        <button type="button" className="btn-outline" disabled={query.page <= 1} onClick={() => { pageFocus.current = true; changeQuery({ page: query.page - 1 }); }}><ChevronLeft aria-hidden="true" size={16} /> Anterior</button>
        <span className="text-sm">{query.page} / {pagination.totalPages}</span>
        <button type="button" className="btn-outline" disabled={query.page >= pagination.totalPages} onClick={() => { pageFocus.current = true; changeQuery({ page: query.page + 1 }); }}>Próxima <ChevronRight aria-hidden="true" size={16} /></button>
      </nav>}
    </section>

    {numericOpen && !isAdmin && <Suspense fallback={<p role="status">Abrindo rascunhos numéricos…</p>}><NumericQuestionDrafts identity={user.id} onClose={() => { setNumericOpen(false); requestAnimationFrame(() => numericButton.current?.focus()); }} /></Suspense>}
    {editorOpen && !isAdmin && <AssessmentDialog title={form.id ? 'Editar questão autoral' : 'Criar questão autoral'} onClose={closeEditor} closeDisabled={busy} wide>
      {aiOpen && isEnabled('question_bank.ai_assistant') ? <QuestionAiAssistant original={form} session={aiSession.current} onDirty={() => { dirty.current = true; }} onBack={() => { setAiOpen(false); requestAnimationFrame(() => aiButton.current?.focus()); }} onApply={result => {
        const next = aiToEditor(form, result);
        setForm(next); dirty.current = true; setAiOpen(false); requestAnimationFrame(() => editorStatement.current?.focus());
        toast.success('Sugestão levada ao editor. Confira o texto de apoio e a imagem antes de salvar.');
      }} /> : <div className="bank-form space-y-3 p-3 sm:p-4">
        {isEnabled('question_bank.ai_assistant') && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm dark:border-cyan-400/20 dark:bg-cyan-950/20"><p>Quer uma sugestão? Você revisa e escolhe o que aproveitar.</p><button type="button" ref={aiButton} className="btn-outline" disabled={busy} onClick={() => { aiSession.current ||= createAiAuthoringSession(api); setAiOpen(true); }}>Ajuda de IA</button></div>}
        {form.ai_request_id && <p role="status" className="text-sm text-teal-800 dark:text-cyan-200">Sugestão revisada no editor. Só será salva quando você escolher “Salvar questão autoral”.</p>}
        <AuthoringWriteAlert message={editorError} uncertain={editorUncertain} href="/banco-questoes?tab=author" onAcknowledge={() => { setEditorUncertain(false); setEditorError(''); }} />
        {[['anos escolares', gradeResource], ['unidades temáticas', unitResource], ['habilidades BNCC', skillResource]].filter(([,r]) => r.status === 'error').map(([name,r]) => <div key={name} role="alert" className="space-y-2 text-sm"><p>Não foi possível carregar {name}. Seus campos foram preservados.</p><button type="button" className="btn-outline" onClick={r.retry}>Recarregar {name}</button></div>)}
        <fieldset disabled={busy} className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">Só você e a administração podem acessar esta questão.</p>
          <section className="space-y-3">
            <h3 className="text-base font-bold">1. Escreva a questão</h3>
            <label className="block"><span className="label">Enunciado</span><textarea ref={editorStatement} aria-label="Enunciado" className="input min-h-28" maxLength={10000} value={form.statement} onChange={e => editField('statement', e.target.value)} placeholder="Escreva a pergunta de forma clara e completa." /></label>
            <label className="block"><span className="label">Texto de apoio (opcional)</span><textarea aria-label="Texto de apoio (opcional)" className="input min-h-20" value={form.support_text} onChange={e => editField('support_text', e.target.value)} /></label>
          </section>
          <section className="space-y-3 border-t border-slate-200 pt-3 dark:border-white/10">
            <h3 className="text-base font-bold">2. Escolha a habilidade</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label><span className="label">Ano escolar</span><select aria-label="Ano escolar" className="input" value={form.grade_id} disabled={gradeResource.status !== 'ready'} onChange={e => { dirty.current = true; setForm(current => ({ ...current, grade_id: e.target.value, unit_id: '', skill_id: '' })); }}><option value="">Selecione o ano</option>{gradeResource.data?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
              <label><span className="label">Unidade temática</span><select aria-label="Unidade temática" className="input" value={form.unit_id} disabled={unitResource.status !== 'ready'} onChange={e => { dirty.current = true; setForm(current => ({ ...current, unit_id: e.target.value, skill_id: '' })); }}><option value="">Selecione a unidade</option>{unitResource.data?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            </div>
            <label className="block"><span className="label">Habilidade BNCC</span><select aria-label="Habilidade BNCC" aria-describedby={chosenSkill ? 'author-skill-description' : undefined} className="input" value={form.skill_id} disabled={skillResource.status !== 'ready'} onChange={e => editField('skill_id', e.target.value)}><option value="">Selecione a habilidade</option>{skillResource.data?.map(s => <option key={s.id} value={s.id}>{s.code} — {s.description}</option>)}</select></label>
            {chosenSkill && <p id="author-skill-description" className="text-sm leading-relaxed">{chosenSkill.code} — {chosenSkill.description}</p>}
          </section>
          <section className="space-y-2 border-t border-slate-200 pt-3 dark:border-white/10">
            <h3 className="text-base font-bold">3. Alternativas e resposta correta</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300">Preencha as quatro opções e marque a resposta correta.</p>
            {form.options.map((o, index) => <div key={o.option_label} className={'flex flex-wrap items-center gap-2 rounded-xl border p-3 ' + (Number(o.is_correct) === 1 ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-400/30 dark:bg-emerald-400/10' : 'border-slate-200 dark:border-white/10')}>
              <label className="min-w-0 flex-1"><span className="label">Alternativa {o.option_label}</span><input className="input min-w-0" value={o.option_text} onChange={e => { dirty.current = true; setForm(current => ({ ...current, options: current.options.map((option,i) => i === index ? { ...option, option_text: e.target.value } : option) })); }} /></label>
              <label className="flex items-center gap-2 rounded-lg px-2 text-sm"><input type="radio" aria-label={'Resposta correta ' + o.option_label} name="author-correct" checked={Number(o.is_correct) === 1} onChange={() => { dirty.current = true; setForm(current => ({ ...current, options: current.options.map(option => ({ ...option, is_correct: Number(option.option_label === o.option_label) })) })); }} /> Correta</label>
            </div>)}
          </section>
          <section className="space-y-3 border-t border-slate-200 pt-3 dark:border-white/10">
            <h3 className="text-base font-bold">4. Complete a questão</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label><span className="label">Dificuldade</span><select aria-label="Dificuldade" className="input" value={form.difficulty} onChange={e => editField('difficulty', e.target.value)}>{Object.entries(difficultyLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span className="label">Espaço para cálculos na prova</span><select aria-label="Espaço para cálculos na prova" className="input" value={form.development_space} onChange={e => editField('development_space', e.target.value)}><option value="none">Sem espaço adicional</option><option value="small">Pequeno</option><option value="medium">Médio</option><option value="large">Grande</option></select></label>
            </div>
            <label className="block"><span className="label">Comentário ou resolução (opcional)</span><textarea aria-label="Comentário ou resolução (opcional)" className="input min-h-24" value={form.official_explanation} onChange={e => editField('official_explanation', e.target.value)} /></label>
            {imagePreview ? <div><QuestionImage src={imagePreview} alt="Prévia da questão" variant="preview" /><button type="button" className="btn-outline mt-2" onClick={() => selectImage(null)}>Remover imagem</button></div>
              : <label className="flex cursor-pointer flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 p-3 text-sm dark:border-white/20"><ImageIcon aria-hidden="true" size={20} /><span>Adicionar imagem (opcional)<span className="block text-xs text-slate-600 dark:text-slate-300">{imageUploadHint}</span></span><input type="file" className="sr-only" aria-label="Adicionar imagem" accept={imageAccept} onChange={e => selectImage(e.target.files?.[0] || null)} /></label>}
          </section>
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10">
            <button type="button" className="btn-outline" onClick={closeEditor}>Cancelar</button>
            <button type="button" className="btn-primary" disabled={busy || editorUncertain || (form.skill_id && !categoriesReady)} onClick={saveQuestion}><Save aria-hidden="true" size={16} />{busy ? 'Salvando…' : 'Salvar questão autoral'}</button>
          </div>
        </fieldset>
      </div>}
    </AssessmentDialog>}

  </section>;
}
