import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import useReadOnlyResource from '../hooks/useHomeResource';
import MaterialCard from '../components/MaterialCard';
import MaterialResourceState, { materialSurface, materialButton } from '../components/MaterialResourceState';
import { CollectionRemoval, collectionInput } from '../components/CollectionDialogs';
import { parseCollection, collectionGrade, collectionType, collectionOptions, filterCollection } from '../services/collectionsView.mjs';

export default function CollectionView() {
  const { id } = useParams();
  const { user, announcementAccessId } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  return <CollectionMaterials key={`${identity}:${id}`} id={id} identity={identity} isAdmin={user?.role === 'admin'} />;
}
function CollectionMaterials({ id, identity, isAdmin }) {
  const resource = useReadOnlyResource(`/collections/${id}`, identity, parseCollection);
  const [params, setParams] = useSearchParams();
  const [removal, setRemoval] = useState(null);
  const collection = resource.data;
  const grade = params.get('ano') || '', type = params.get('tipo') || '';
  const materials = collection?.materials || [];
  const grades = collectionOptions(materials, collectionGrade, 'Sem ano definido');
  const types = collectionOptions(filterCollection(materials, grade, ''), collectionType, 'Sem tipo definido');
  const filtered = filterCollection(materials, grade, type);
  const change = (name, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value); else next.delete(name);
    if (name === 'ano') next.delete('tipo');
    setParams(next);
  };
  const clear = () => { const next = new URLSearchParams(params); next.delete('ano'); next.delete('tipo'); setParams(next); };
  return <div data-collection-view className="mx-auto max-w-7xl bg-slate-50 px-4 pb-6 pt-2 sm:px-6 text-slate-900 dark:bg-transparent dark:text-slate-100">
    <Link to="/colecoes" className={materialButton}><ArrowLeft size={16} aria-hidden="true" />Voltar para laboratórios</Link>
    <MaterialResourceState resource={resource} label="este laboratório" />
    {collection && <>
      <header className="mb-3 mt-1">
        <h1 className="break-words text-xl font-bold sm:text-2xl">{collection.name}</h1>
        {isAdmin && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{collection.is_public ? 'Visível para professores' : 'Restrito'}</p>}
        {collection.description && <details className="group mt-1 text-sm text-slate-600 dark:text-slate-300">
          <summary className="flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-lg font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300">Sobre este laboratório<ChevronDown size={16} className="group-open:rotate-180" aria-hidden="true" /></summary>
          <p className="max-w-3xl whitespace-pre-line break-words pb-2">{collection.description}</p>
        </details>}
      </header>
      {!!materials.length && <div className="mb-3 grid grid-cols-2 items-end gap-2 sm:max-w-xl sm:gap-3">
        <div className="min-w-0 text-sm font-semibold"><label htmlFor="collection-grade">Ano escolar</label>
          <select id="collection-grade" value={grade} onChange={e => change('ano', e.target.value)} className={`${collectionInput} mt-1`}>
            <option value="">Todos os anos</option>
            {grade && !grades.includes(grade) && <option value={grade}>{grade} (indisponível)</option>}
            {grades.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div className="min-w-0 text-sm font-semibold"><label htmlFor="collection-type">Tipo de material</label>
          <select id="collection-type" value={type} onChange={e => change('tipo', e.target.value)} className={`${collectionInput} mt-1`}>
            <option value="">Todos os tipos</option>
            {type && !types.includes(type) && <option value={type}>{type} (indisponível)</option>}
            {types.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      </div>}
      <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-x-2">
        <h2 aria-live="polite" className="text-sm font-semibold">{filtered.length} {filtered.length === 1 ? 'material disponível' : 'materiais disponíveis'}{(grade || type) && ' neste filtro'}</h2>
        {(grade || type) && <button type="button" className={materialButton} onClick={clear}>Limpar filtros</button>}
      </div>
      {filtered.length ? <div data-collection-materials className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map(material => <div key={material.id} className="flex min-w-0 flex-col [&>a]:h-auto [&>a]:flex-1">
          <MaterialCard material={material} compactOnMobile />
          {isAdmin && <button type="button" className={`${materialButton} mt-1`} aria-label={`Remover ${material.title} deste laboratório`} onClick={() => setRemoval(material)}><Trash2 size={16} aria-hidden="true" />Remover deste laboratório</button>}
        </div>)}
      </div> : <section className={`${materialSurface} p-4`}>
        <h3 className="font-semibold">{materials.length ? 'Nenhum material neste filtro' : 'Este laboratório ainda não tem materiais'}</h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{materials.length ? 'Escolha outro ano ou tipo, ou limpe os filtros.' : isAdmin ? 'Abra um material na Biblioteca e use “Adicionar ao laboratório”.' : 'Você pode consultar outros materiais na Biblioteca.'}</p>
        {!materials.length && <Link className={`${materialButton} mt-2`} to="/biblioteca">Ir para Biblioteca</Link>}
      </section>}
    </>}
    {isAdmin && removal && <CollectionRemoval item name={removal.title} url={`/collections/${id}/items/${removal.id}`} close={() => setRemoval(null)} refresh={resource.retry} />}
  </div>;
}
