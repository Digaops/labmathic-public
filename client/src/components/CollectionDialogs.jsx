import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import ModalLayer from './ModalLayer';
import { materialButton, materialFocus, materialSurface } from './MaterialResourceState';
import { materialFileUrl } from '../services/materialView.mjs';
import { imageAccept, imageUploadHint, uploadSelectionError } from '../services/uploadSelection.mjs';
import api from '../services/api';
import useMaterialAction from '../hooks/useMaterialAction';

export const collectionInput = `min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 ${materialFocus}`;
export const collectionPrimary = `${materialButton} bg-blue-600 !text-white hover:!bg-blue-700`;

function Dialog({ title, busy, close, children }) {
  return <ModalLayer label={title} closeDisabled={busy} onClick={close} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
    <section className={`${materialSurface} flex w-full max-w-lg flex-col p-4 sm:p-5 text-slate-800 dark:text-slate-100`}>
      <div className="mb-3 flex shrink-0 items-start justify-between gap-2">
        <h2 className="pt-2 text-lg font-bold">{title}</h2>
        <button type="button" onClick={close} disabled={busy} className={materialButton} aria-label="Fechar"><X size={20} aria-hidden="true" /></button>
      </div>{children}
    </section>
  </ModalLayer>;
}

export function CollectionEditor({ collection, close, refresh }) {
  const [form, setForm] = useState({ name: collection?.name || '', description: collection?.description || '', is_public: collection ? !!collection.is_public : true });
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const action = useMaterialAction();
  useEffect(() => {
    if (!file) { setPreview(''); return undefined; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const change = event => {
    const selected = event.target.files?.[0]; if (!selected) return;
    const invalid = uploadSelectionError(selected, 'image');
    setError(invalid || '');
    if (invalid) { event.target.value = ''; return; }
    setFile(selected);
  };
  const save = event => {
    event.preventDefault();
    if (!form.name.trim()) { setError('Digite um nome para o laboratório.'); return; }
    setError('');
    const data = new FormData();
    data.append('name', form.name.trim()); data.append('description', form.description.trim()); data.append('is_public', form.is_public ? '1' : '0');
    if (file) data.append('image', file);
    action.run(() => collection ? api.put(`/collections/${collection.id}`, data, { timeout: 15000 }) : api.post('/collections', data, { timeout: 15000 }), {
      refresh, onSuccess: close, onError: setError, message: collection ? 'Laboratório atualizado.' : 'Laboratório criado.',
    });
  };
  const cover = preview || materialFileUrl(collection?.image_path);
  return <Dialog title={collection ? 'Editar laboratório' : 'Novo laboratório'} busy={action.busy} close={close}>
    <form onSubmit={save} className="flex min-h-0 flex-col" aria-busy={action.busy}>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain px-1 pb-3">
        <fieldset disabled={action.busy} className="space-y-3">
        <label className="block text-sm font-semibold">Nome do laboratório
          <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={`${collectionInput} mt-1`} />
        </label>
        <label className="block text-sm font-semibold">Descrição (opcional)
          <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} className={`${collectionInput} mt-1`} />
        </label>
        <label className="block text-sm font-semibold">Capa (opcional)
          <input type="file" accept={imageAccept} onChange={change} aria-describedby="collection-image-hint" className={`mt-1 block min-h-11 w-full min-w-0 rounded-lg text-xs file:mr-2 file:min-h-11 file:rounded-lg file:border-0 file:bg-slate-200 file:px-3 file:font-semibold file:text-slate-900 dark:file:bg-slate-700 dark:file:text-white ${materialFocus}`} />
        </label>
        <p id="collection-image-hint" className="text-xs text-slate-600 dark:text-slate-300">{imageUploadHint}</p>
        {cover && <img src={cover} alt="Prévia da capa" className="h-20 w-28 rounded-lg object-cover" />}
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
          <input type="checkbox" checked={form.is_public} onChange={e => setForm({ ...form, is_public: e.target.checked })} className={`h-5 w-5 shrink-0 accent-blue-600 ${materialFocus}`} />Visível para professores
        </label>
        <p className="text-xs text-slate-600 dark:text-slate-300">Desmarque para manter este laboratório restrito à sua conta.</p>
        </fieldset>
      </div>
      {error && <p role="alert" className="max-h-28 shrink-0 overflow-y-auto pb-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10">
        <button type="button" className={materialButton} disabled={action.busy} onClick={close}>Cancelar</button>
        <button type="submit" className={collectionPrimary} disabled={action.busy}>{action.busy ? 'Salvando…' : collection ? 'Salvar alterações' : 'Criar laboratório'}</button>
      </div>
    </form>
  </Dialog>;
}

export function CollectionRemoval({ name, url, item = false, close, refresh }) {
  const action = useMaterialAction();
  const [error, setError] = useState('');
  return <Dialog title={item ? 'Remover deste laboratório?' : 'Excluir laboratório?'} busy={action.busy} close={close}>
    <p className="break-words text-sm font-semibold">{name}</p>
    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{item ? 'O material continuará na Biblioteca e nos outros laboratórios.' : 'Os materiais continuarão na Biblioteca. Apenas este agrupamento será excluído.'}</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button type="button" className={materialButton} disabled={action.busy} onClick={close}>Cancelar</button>
      <button type="button" className={`${materialButton} bg-red-700 !text-white hover:!bg-red-800`} disabled={action.busy}
        onClick={() => action.run(() => api.delete(url, { timeout: 15000 }), { refresh, onSuccess: close, onError: setError, message: item ? 'Material removido deste laboratório.' : 'Laboratório excluído. Os materiais foram preservados.' })}>
        {action.busy ? 'Aguarde…' : item ? 'Remover do laboratório' : 'Excluir laboratório'}
      </button>
    </div>
  </Dialog>;
}
