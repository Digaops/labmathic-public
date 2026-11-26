import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import useReadOnlyResource from '../hooks/useHomeResource';
import MaterialResourceState, { materialSurface, materialButton, materialFocus } from '../components/MaterialResourceState';
import { CollectionEditor, CollectionRemoval, collectionPrimary } from '../components/CollectionDialogs';
import { parseCollectionList } from '../services/collectionsView.mjs';
import { materialFileUrl } from '../services/materialView.mjs';

export default function Collections() {
  const { user, announcementAccessId } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  return <CollectionList key={identity} identity={identity} isAdmin={user?.role === 'admin'} />;
}
function CollectionList({ identity, isAdmin }) {
  const resource = useReadOnlyResource('/collections', identity, parseCollectionList);
  const [editor, setEditor] = useState(null);
  const [removal, setRemoval] = useState(null);
  return <div data-collections className="mx-auto max-w-7xl bg-slate-50 px-4 py-4 sm:px-6 sm:py-5 text-slate-900 dark:bg-transparent dark:text-slate-100">
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-bold">Laboratórios</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Coleções de materiais para suas aulas.</p></div>
      {isAdmin && <button type="button" onClick={() => setEditor({})} className={collectionPrimary}><Plus size={18} aria-hidden="true" />Novo laboratório</button>}
    </header>
    <MaterialResourceState resource={resource} label="os laboratórios" />
    {resource.status === 'ready' && (resource.data.length ? <div data-collection-list className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {resource.data.map(collection => {
        const cover = materialFileUrl(collection.image_path);
        return <article key={collection.id} className={`${materialSurface} min-w-0 overflow-hidden`}>
          <Link to={`/colecoes/${collection.id}`} className={`block rounded-2xl transition-colors hover:bg-slate-50 dark:hover:bg-white/5 ${materialFocus}`}>
            {cover && <img src={cover} alt="" loading="lazy" className="h-28 w-full object-cover sm:h-32" />}
            <div className="p-4">
              <h2 className="break-words text-lg font-bold leading-snug">{collection.name}</h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{collection.item_count} {collection.item_count === 1 ? 'material' : 'materiais'}{isAdmin && ` · ${collection.is_public ? 'Visível para professores' : 'Restrito'}`}</p>
              {collection.description && <p className="mt-2 line-clamp-2 break-words text-sm text-slate-600 dark:text-slate-300">{collection.description}</p>}
              <span className="mt-3 flex min-h-11 items-center gap-2 text-sm font-semibold text-cyan-800 dark:text-cyan-200">Ver materiais<ArrowRight size={16} aria-hidden="true" /></span>
            </div>
          </Link>
          {isAdmin && <div className="flex flex-wrap gap-2 border-t border-slate-200 px-3 py-1 dark:border-white/10">
            <button type="button" className={materialButton} onClick={() => setEditor(collection)} aria-label={`Editar ${collection.name}`}><Pencil size={16} aria-hidden="true" />Editar</button>
            <button type="button" className={materialButton} onClick={() => setRemoval(collection)} aria-label={`Excluir ${collection.name}`}><Trash2 size={16} aria-hidden="true" />Excluir</button>
          </div>}
        </article>;
      })}
    </div> : <section className={`${materialSurface} p-4`}><h2 className="font-bold">Nenhum laboratório disponível</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{isAdmin ? 'Crie uma coleção e adicione materiais pela Biblioteca.' : 'Você pode encontrar materiais na Biblioteca enquanto as coleções são preparadas.'}</p>
      <Link to="/biblioteca" className={`${materialButton} mt-2`}>Ir para Biblioteca</Link>
    </section>)}
    {isAdmin && editor && <CollectionEditor collection={editor.id ? editor : null} close={() => setEditor(null)} refresh={resource.retry} />}
    {isAdmin && removal && <CollectionRemoval name={removal.name} url={`/collections/${removal.id}`} close={() => setRemoval(null)} refresh={resource.retry} />}
  </div>;
}
