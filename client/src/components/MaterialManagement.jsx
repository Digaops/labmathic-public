import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Share2, FolderPlus, X } from 'lucide-react';
import api from '../services/api';
import useReadOnlyResource from '../hooks/useHomeResource';
import { parseCollections } from '../services/materialView.mjs';
import MaterialSharePanel from './MaterialSharePanel';
import MaterialResourceState, { materialButton as button, materialSurface as surface } from './MaterialResourceState';

export default function MaterialManagement({ id, identity, fileUrl, action }) {
  const [showShare, setShowShare] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const collections = useReadOnlyResource(showCollections ? '/collections' : null, identity, parseCollections);
  return <section aria-label="Gerenciar material" className={`${surface} space-y-3 p-4`}>
    <h2 className="font-bold text-slate-900 dark:text-white">Gerenciar material</h2>
    <div className="flex flex-wrap gap-2">
      <Link to={`/admin/materiais/${id}/habilidades`} className={button}>Habilidades BNCC</Link>
      {fileUrl && <a href={fileUrl} download className={button}><Download size={18} aria-hidden="true" />Baixar arquivo</a>}
      <button type="button" className={button} aria-expanded={showShare} onClick={() => setShowShare(value => !value)}><Share2 size={18} aria-hidden="true" />Compartilhar</button>
      <button type="button" className={button} aria-expanded={showCollections} onClick={() => setShowCollections(value => !value)}><FolderPlus size={18} aria-hidden="true" />Adicionar ao laboratório</button>
    </div>
    {showShare && <MaterialSharePanel materialId={id} onClose={() => setShowShare(false)} />}
    {showCollections && <section aria-label="Escolher laboratório" className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
      <div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-slate-900 dark:text-white">Escolha o laboratório</h3><button type="button" className={button} aria-label="Fechar lista de laboratórios" disabled={action.busy} onClick={() => setShowCollections(false)}><X size={18} aria-hidden="true" /></button></div>
      <MaterialResourceState resource={collections} label="os laboratórios" />
      {collections.status === 'ready' && (collections.data.length ? <ul className="max-h-64 overflow-y-auto">{collections.data.map(collection => <li key={collection.id}><button type="button" className={`${button} w-full justify-start text-left`} disabled={action.busy} onClick={() => action.run(() => api.post(`/collections/${collection.id}/items`, { material_id: id }, { timeout: 15000 }), { refresh: collections.retry, message: 'Material adicionado ao laboratório.', onSuccess: () => setShowCollections(false) })}><span className="min-w-0 break-words">{collection.name}</span></button></li>)}</ul> : <p className="text-sm text-slate-600 dark:text-slate-300">Nenhum laboratório disponível. Cadastre um na área de Laboratórios.</p>)}
    </section>}
  </section>;
}
