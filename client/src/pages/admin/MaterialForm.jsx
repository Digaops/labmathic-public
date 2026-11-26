import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import useHomeResource from '../../hooks/useHomeResource';
import useAccountLeave from '../../hooks/useAccountLeave';
import useMaterialEditor from '../../hooks/useMaterialEditor';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { draftSnapshot } from '../../services/materialDraftView.mjs';
import { Navigate } from 'react-router-dom';
import { materialAccept, materialUploadHint, uploadSelectionError } from '../../services/uploadSelection.mjs';
import { materialSnapshot, materialOptions, materialDraft, materialFormError, materialPayload } from '../../services/materialFormView.mjs';

const panel = 'rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 dark:border-white/10 dark:bg-[#111E31]';
const button = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5';
const field = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-white/20 dark:bg-[#0B1728] dark:text-slate-100';
const summary = 'min-h-11 cursor-pointer list-inside py-3 text-sm font-bold';
const labels = { discipline_id: 'Disciplina', grade_id: 'Ano escolar', material_type_id: 'Tipo de material' };

export default function MaterialForm({ draftMode = false }) {
  const params = useParams(), id = draftMode ? params.draftId : params.id, { user, announcementAccessId } = useAuth();
  const flags = useFeatureFlags();
  const [revision, setRevision] = useState(0), identity = `${user?.id}:${announcementAccessId}`;
  if (!id && !draftMode) {
    if (flags.loading || flags.unavailable) return <p role="status" className="p-4">Conferindo acesso ao cadastro…{flags.unavailable && <button type="button" className={button} onClick={flags.refresh}>Tentar novamente</button>}</p>;
    // A pilot rollout must not strand the receipt of an older, in-flight create.
    let legacyPending = false;
    try { legacyPending = /^[a-zA-Z0-9_-]{20,120}$/.test(sessionStorage.getItem(`labmathic_material_operation_v1:${identity}:new`) || ''); } catch { /* Closed storage is handled by the editor. */ }
    if (flags.isEnabled('materials.draft_publication') && !legacyPending) return <Navigate replace to="/admin/materiais/rascunhos/novo" />;
  }
  return user?.role === 'admin' ? <LoadEditor key={`${identity}:${draftMode}:${id || 'new'}:${revision}`} identity={identity} id={id} draftMode={draftMode} onReload={() => setRevision(n => n + 1)} /> : null;
}
function LoadEditor({ identity, id, onReload, draftMode }) {
  const action = useMaterialEditor(identity, id, draftMode ? 'draft' : 'material');
  const valid = !id || (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)));
  const parse = useMemo(() => data => (draftMode ? draftSnapshot : materialSnapshot)(data, id), [id, draftMode]);
  const resource = useHomeResource(id && valid ? '/materials/management/' + (draftMode ? 'drafts/' : '') + id : null, identity, parse);
  if (draftMode && resource.data?.publishedMaterialId) return <Navigate replace to={`/admin/materiais/rascunhos/${id}`} />;
  return <div data-material-form className="mx-auto max-w-4xl space-y-3 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header className="flex items-center justify-between gap-3"><h1 className="text-xl font-bold sm:text-2xl">{draftMode ? id ? 'Editar rascunho' : 'Novo rascunho' : id ? 'Editar material' : 'Novo material'}</h1><Link className={button + ' shrink-0'} to="/admin/materiais">Voltar à lista</Link></header>
    {action.status === 'success' ? <SavedMaterial receipt={action.receipt} id={id} onReload={onReload} />
      : !valid || (id && resource.status === 'error') ? <section role="alert" className={panel}><p>Não foi possível carregar este material. Nenhum formulário vazio será salvo por cima dos dados existentes.</p>{valid && <button type="button" className={button} onClick={resource.retry}>Tentar carregar novamente</button>}{['uncertain', 'checking'].includes(action.status) && <div className="mt-2 text-sm leading-6"><p>{action.message}</p><button type="button" className={button} disabled={action.status === 'checking'} onClick={action.check}>Conferir pedido</button></div>}</section>
      : id && resource.status !== 'ready' ? <p role="status" className="text-sm">Carregando os dados atuais do material…</p>
        : <Editor identity={identity} id={id} action={action} draftMode={draftMode} snapshot={id ? resource.data : null} onReload={onReload} />}
  </div>;
}
function SavedMaterial({ receipt, id, onReload }) {
  if (receipt.draftId) return <section data-material-saved className={panel}><h2 tabIndex={-1} ref={node => node?.focus()} className="text-lg font-bold">Rascunho salvo</h2><p role="status" className="mt-2 break-words">{receipt.title}</p><p className="mt-2 text-sm">Ainda não aparece para os professores. Você pode continuar depois ou conferir o conteúdo para publicar.</p><div className="mt-3 flex flex-wrap gap-2"><Link className={button} to={`/admin/materiais/rascunhos/${receipt.draftId}`}>Conferir e publicar</Link>{id ? <button type="button" className={button} onClick={onReload}>Continuar rascunho</button> : <Link className={button} to={`/admin/materiais/rascunhos/${receipt.draftId}/editar`}>Continuar rascunho</Link>}<Link className={button} to="/admin/materiais/rascunhos">Meus rascunhos</Link></div></section>;
  return <section data-material-saved className={panel}><h2 tabIndex={-1} ref={node => node?.focus()} className="text-lg font-bold">Material salvo</h2><p role="status" className="mt-2 break-words">{receipt.title} · Código {receipt.materialId}</p><p className="mt-2 text-sm leading-6">O pedido foi confirmado no acervo. Para continuar editando, carregue os dados atuais.</p><div className="mt-3 flex flex-wrap gap-2"><Link className={button} to={`/material/${receipt.materialId}`}>Ver material</Link>{id ? <button type="button" className={button} onClick={onReload}>Continuar edição</button> : <Link className={button} to={`/admin/materiais/${receipt.materialId}/editar`}>Continuar edição</Link>}<Link className={button} to="/admin/materiais">Ir para a lista</Link>{!id && <button type="button" className={button} onClick={onReload}>Cadastrar outro material</button>}</div></section>;
}
function Editor({ identity, id, action, snapshot, onReload, draftMode }) {
  const flags = useFeatureFlags();
  const initial = useMemo(() => ({ ...materialDraft(snapshot), ...(draftMode ? { addCollectionIds: snapshot?.material.addCollectionIds || [] } : {}) }), [snapshot, draftMode]);
  const [form, setForm] = useState(initial), [file, setFile] = useState(null), [fileError, setFileError] = useState(''), [error, setError] = useState(''), [drag, setDrag] = useState(false);
  const [topicSearch, setTopicSearch] = useState(''), [collectionSearch, setCollectionSearch] = useState('');
  const formRef = useRef(null), fileInput = useRef(null), alertRef = useRef(null), topicInput = useRef(null), collectionInput = useRef(null);
  const disciplines = useHomeResource('/categories/disciplines', identity, materialOptions), grades = useHomeResource('/categories/grades', identity, materialOptions), types = useHomeResource('/categories/material-types', identity, materialOptions);
  const topics = useHomeResource('/categories/topics', identity, materialOptions), collections = useHomeResource('/collections', identity, materialOptions);
  useEffect(() => {
    if (['error', 'conflict', 'uncertain'].includes(action.status) && action.message) {
      alertRef.current?.focus({ preventScroll: true });
      alertRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [action.status, action.message]);
  const busy = action.status === 'busy', uncertain = ['uncertain', 'checking'].includes(action.status), frozen = busy || uncertain || ['conflict', 'success'].includes(action.status) || (draftMode && !flags.isEnabled('materials.draft_publication'));
  const dirty = action.status !== 'success' && (Boolean(file) || JSON.stringify(form) !== JSON.stringify(initial) || uncertain);
  useAccountLeave(dirty, () => action.pending.current, uncertain ? 'Há um pedido sem confirmação. O código continuará nesta aba, mas o texto e o arquivo selecionado serão perdidos. Sair mesmo assim?' : undefined);
  const resources = { discipline_id: disciplines, grade_id: grades, material_type_id: types };
  const names = [...(snapshot?.topics || []), ...(topics.data || [])];
  const selectedCollections = form.addCollectionIds.map(n => collections.data?.find(c => c.id === n) || { id: n, name: 'Laboratório selecionado' });
  function change(key, value) { if (!frozen) { setForm(f => ({ ...f, [key]: value })); setError(''); } }
  function selectFile(files) {
    if (frozen || !files?.length) return;
    const problem = files.length !== 1 ? 'Envie um arquivo por vez.' : uploadSelectionError(files[0]);
    if (problem) { setFileError(problem + (file ? ' O arquivo selecionado antes foi mantido.' : ' O arquivo atual não foi alterado.')); if (fileInput.current) fileInput.current.value = ''; return; }
    setFile(files[0]); setFileError(''); change('replaceFile', false);
  }
  function submit(e) {
    e.preventDefault(); if (frozen) return;
    const issue = materialFormError(form, file, snapshot);
    if (issue) { setError(issue[1]); const input = formRef.current.elements.namedItem(issue[0]); for (let p = input?.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true; input?.focus(); return; }
    setError(''); action.save(materialPayload(form, snapshot), file);
  }
  function retryLoad() { if (!dirty || window.confirm('Recarregar descarta as alterações e o arquivo selecionado nesta tela. Continuar?')) onReload(); }
  return <>
    <p className="text-sm leading-6">{draftMode ? 'Comece pelo título e salve para continuar depois. O rascunho fica somente nesta conta administrativa; os professores só terão acesso após a publicação.' : 'O título é obrigatório. Confira o arquivo e a classificação antes de salvar.'}</p>
    {draftMode && !flags.isEnabled('materials.draft_publication') && <p role="status" className="text-sm">A gravação de rascunhos não está liberada agora. Os dados salvos foram preservados.</p>}
    {(action.message || error) && <section ref={alertRef} tabIndex={-1} role={busy || action.status === 'checking' ? 'status' : 'alert'} className={panel + ' scroll-mt-28 text-sm leading-6'}><p>{error || action.message}</p>
      {uncertain && <><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={action.status === 'checking'} onClick={action.check}>Conferir pedido</button>{action.retryAvailable ? <button type="button" className={button} disabled={action.status === 'checking'} onClick={action.retry}>Reenviar o mesmo pedido</button> : <button type="button" className={button} disabled={action.status === 'checking'} onClick={action.prepareAgain}>Preparar novamente</button>}</div><p className="mt-1">O código fica nesta aba. Arquivos e textos não são guardados após fechar ou recarregar a página.</p></>}
      {action.status === 'conflict' && <button type="button" className={button} onClick={retryLoad}>Carregar versão atual</button>}
    </section>}
    <form ref={formRef} noValidate onSubmit={submit} className="space-y-3" aria-label="Dados do material">
      <fieldset disabled={frozen} className="min-w-0 space-y-3">
        <section className={panel + ' space-y-3'}>
          <label className="block text-sm font-semibold" htmlFor="title">Título do material *</label><input id="title" name="title" className={field} maxLength={200} value={form.title} onChange={e => change('title', e.target.value)} placeholder="Ex.: Frações no dia a dia" />
          <details><summary className={summary}>Descrição (opcional)</summary><label className="sr-only" htmlFor="description">Descrição</label><textarea id="description" name="description" className={field + ' resize-y'} rows={3} maxLength={5000} value={form.description} onChange={e => change('description', e.target.value)} placeholder="Como este material pode ajudar na aula?" /></details>
        </section>
        <section className={panel + ' space-y-3'}><h2 className="text-sm font-bold">Arquivo e link</h2>
          <p className="text-sm leading-6">{snapshot?.material.file_path ? `Arquivo atual: ${snapshot.material.file_format || 'arquivo cadastrado'}. Será mantido se você não escolher outro.` : 'Você pode enviar um arquivo ou informar um link.'}</p>
          <div onDragOver={e => { e.preventDefault(); if (!frozen) setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); selectFile(e.dataTransfer.files); }} className={'rounded-xl border border-dashed p-3 ' + (drag ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-500/10' : 'border-slate-300 dark:border-white/20')}>
            <label className={button + ' relative cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-cyan-600'}>Selecionar arquivo<input ref={fileInput} type="file" className="sr-only" aria-label="Selecionar arquivo" accept={materialAccept} onChange={e => selectFile(e.target.files)} /></label><span className="ml-2 text-xs text-slate-600 dark:text-slate-300">ou arraste um arquivo aqui</span>
            {file && <div className="mt-2"><p className="break-words text-sm font-semibold">{file.name}</p><p className="text-xs">{(file.size / 1024 / 1024).toFixed(2)} MB · ainda não enviado</p><button type="button" className={button} onClick={() => { setFile(null); change('replaceFile', false); setFileError(''); fileInput.current.value = ''; fileInput.current.focus(); }}>Cancelar escolha do arquivo</button></div>}
          </div>
          {fileError && <p role="alert" className="text-sm text-red-700 dark:text-red-200">{fileError}</p>}
          {file && snapshot?.material.file_path && <label className="flex min-h-11 items-center gap-3 text-sm leading-6"><input name="replaceFile" type="checkbox" checked={form.replaceFile} onChange={e => change('replaceFile', e.target.checked)} />Substituir o arquivo atual ao salvar.</label>}
          <details><summary className={summary}>Formatos e limites de arquivo</summary><p className="text-sm leading-6">{materialUploadHint}</p><p className="mt-1 break-words text-xs leading-5">Formatos: {materialAccept.replaceAll(',', ', ')}</p></details>
          <label className="block text-sm font-semibold" htmlFor="external_url">Link externo (opcional)</label><input id="external_url" name="external_url" className={field} type="url" maxLength={2000} value={form.external_url} onChange={e => change('external_url', e.target.value)} placeholder="https://…" />
        </section>
        <section className={panel}><h2 className="mb-3 text-sm font-bold">Classificação</h2><div className="grid gap-3 sm:grid-cols-3">{Object.keys(resources).map(key => <div key={key}><label htmlFor={key} className="mb-1 block text-sm font-semibold">{labels[key]}</label><select id={key} name={key} className={field} disabled={resources[key].status !== 'ready'} value={form[key]} onChange={e => change(key, e.target.value)}><option value="">Não informado</option>{form[key] && !resources[key].data?.some(item => String(item.id) === form[key]) && <option value={form[key]}>Seleção atual mantida</option>}{resources[key].data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ResourceState resource={resources[key]} label={labels[key].toLowerCase()} /></div>)}</div><p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300">A disciplina não será trocada automaticamente. Deixe em branco somente o que não se aplica.</p></section>
        <details className={panel}><summary className={summary}>Assuntos e laboratórios</summary><div className="mt-2 space-y-4">
          <section><h2 className="text-sm font-bold">Assuntos do material</h2><div className="mt-2 flex flex-wrap gap-1">{form.topicIds.map(n => <button key={n} type="button" className={button + ' border border-slate-200 dark:border-white/20'} onClick={() => { change('topicIds', form.topicIds.filter(id => id !== n)); topicInput.current?.focus(); }} aria-label={`Remover assunto ${names.find(t => t.id === n)?.name || n}`}>{names.find(t => t.id === n)?.name || 'Assunto atual'} · remover</button>)}</div>
            <label className="mt-2 block text-sm" htmlFor="topic-search">Buscar assunto</label><input ref={topicInput} id="topic-search" className={field} value={topicSearch} disabled={topics.status !== 'ready'} onChange={e => setTopicSearch(e.target.value)} /><ResourceState resource={topics} label="assuntos" />
            {topics.status === 'ready' && topicSearch.trim() && <OptionResults values={topics.data.filter(t => !form.topicIds.includes(t.id) && t.name.toLocaleLowerCase('pt-BR').includes(topicSearch.trim().toLocaleLowerCase('pt-BR')))} onChoose={t => { change('topicIds', [...form.topicIds, t.id]); setTopicSearch(''); topicInput.current?.focus(); }} label="Adicionar assunto" />}
          </section>
          <section><h2 className="text-sm font-bold">Laboratórios</h2><p className="mt-1 text-sm leading-6">{draftMode ? 'O material será adicionado aos laboratórios selecionados somente quando você publicar.' : 'Os vínculos atuais serão mantidos. Para retirar um material, organize os itens dentro do próprio laboratório.'}</p>
            {snapshot?.collections.length > 0 && <ul className="mt-2 space-y-1 text-sm" aria-label="Laboratórios atuais">{snapshot.collections.map(c => <li key={c.id}>{c.name} · já vinculado</li>)}</ul>}
            {snapshot?.otherCollectionCount > 0 && <p className="mt-1 text-sm">Há outros {snapshot.otherCollectionCount} vínculos fora dos laboratórios visíveis nesta conta. Eles também serão preservados.</p>}
            <div className="mt-2 flex flex-wrap gap-1">{selectedCollections.map(c => <button key={c.id} type="button" className={button + ' border border-slate-200 dark:border-white/20'} onClick={() => { change('addCollectionIds', form.addCollectionIds.filter(n => n !== c.id)); collectionInput.current?.focus(); }} aria-label={`Cancelar adição ao laboratório ${c.name}`}>{c.name} · cancelar adição</button>)}</div>
            <label className="mt-2 block text-sm" htmlFor="collection-search">Buscar laboratório para adicionar</label><input ref={collectionInput} id="collection-search" className={field} value={collectionSearch} disabled={collections.status !== 'ready'} onChange={e => setCollectionSearch(e.target.value)} /><ResourceState resource={collections} label="laboratórios" />
            {collections.status === 'ready' && collectionSearch.trim() && <OptionResults values={collections.data.filter(c => !snapshot?.collections.some(s => s.id === c.id) && !form.addCollectionIds.includes(c.id) && c.name.toLocaleLowerCase('pt-BR').includes(collectionSearch.trim().toLocaleLowerCase('pt-BR')))} onChoose={c => { change('addCollectionIds', [...form.addCollectionIds, c.id]); setCollectionSearch(''); collectionInput.current?.focus(); }} label="Adicionar ao laboratório" />}
          </section>
        </div></details>
        <details className={panel}><summary className={summary}>Outras informações (opcional)</summary><div className="mt-2 grid gap-3 sm:grid-cols-2"><div><label htmlFor="duration" className="mb-1 block text-sm font-semibold">Duração do áudio ou vídeo</label><input id="duration" name="duration" className={field} maxLength={80} value={form.duration} onChange={e => change('duration', e.target.value)} placeholder="Ex.: 12 minutos" /></div><div><label htmlFor="page_count" className="mb-1 block text-sm font-semibold">Número de páginas</label><input id="page_count" name="page_count" className={field} type="number" min="0" max="100000" value={form.page_count} onChange={e => change('page_count', e.target.value)} /></div></div></details>
      </fieldset>
      <div className="flex flex-wrap gap-2"><Link className={button} to="/admin/materiais">Cancelar</Link><button type="submit" disabled={frozen} className={button + ' bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-700 dark:text-white'}>{busy ? 'Salvando…' : draftMode ? 'Salvar rascunho' : id ? 'Salvar alterações' : 'Cadastrar material'}</button></div>
    </form>
  </>;
}
function ResourceState({ resource, label }) {
  return resource.status === 'loading' ? <p role="status" className="text-xs leading-5">Carregando {label}…</p> : resource.status === 'error' ? <div role="alert" className="text-xs leading-5"><p>Não foi possível consultar {label}. Suas escolhas foram mantidas.</p><button type="button" className={button} onClick={resource.retry}>Atualizar {label}</button></div> : resource.data?.length === 0 ? <p className="text-xs leading-5">Nenhuma opção cadastrada.</p> : null;
}
function OptionResults({ values, onChoose, label }) {
  const [limit, setLimit] = useState(12);
  return <div className="mt-2">{!values.length ? <p className="text-sm">Nenhuma opção encontrada.</p> : <><ul className="divide-y divide-slate-200 dark:divide-white/10">{values.slice(0, limit).map(v => <li key={v.id}><button type="button" className={button + ' w-full justify-start text-left'} onClick={() => onChoose(v)} aria-label={`${label} ${v.name}`}>{v.name}</button></li>)}</ul>{values.length > limit && <button type="button" className={button} onClick={() => setLimit(n => n + 12)}>Mostrar mais opções</button>}</>}</div>;
}
