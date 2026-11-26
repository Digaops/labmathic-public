import { useRef, useState } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Heart, Info, ExternalLink, ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import MaterialPreview from '../components/MaterialPreview';
import MaterialFeedback from '../components/MaterialFeedback';
import ContentIssueButton from '../components/ContentIssueButton';
import MaterialManagement from '../components/MaterialManagement';
import MaterialSkills from '../components/MaterialSkills';
import MaterialResourceState, { materialButton as button, materialSurface as surface, materialFocus as focus } from '../components/MaterialResourceState';
import { parseMaterial, parseFavorite, materialFormat, materialFileUrl, externalMaterialUrl, materialReturn, materialDate } from '../services/materialView.mjs';

export default function MaterialView() {
  const { id } = useParams();
  const { user, announcementAccessId } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  // Material/identity changes also discard drafts, pending UI and open panels.
  return <MaterialContent key={`${identity}:${id}`} id={id} identity={identity} user={user} />;
}

function MaterialContent({ id, identity, user }) {
  const location = useLocation();
  const navigate = useNavigate();
  const back = materialReturn(location.state);
  // Unlabelled links from Home, notifications or interventions keep their
  // in-app return. A direct entry (router index zero) falls back to Library.
  const hasPreviousScreen = !location.state?.from && Number.isInteger(window.history.state?.idx) && window.history.state.idx > 0;
  const backControl = hasPreviousScreen
    ? <button type="button" className={button} onClick={() => navigate(-1)}><ArrowLeft size={17} aria-hidden="true" />Voltar à tela anterior</button>
    : <Link to={back.to} className={button}><ArrowLeft size={17} aria-hidden="true" />{back.label}</Link>;
  const materialQuery = useReadOnlyResource(`/materials/${id}`, identity, parseMaterial);
  const ready = materialQuery.status === 'ready';
  const favorite = useReadOnlyResource(ready ? `/favorites/check/${id}` : null, identity, parseFavorite);
  const action = useMaterialAction();
  const details = useRef(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsSummary = useRef(null);
  function openDetails() {
    if (!details.current) return;
    details.current.open = true;
    detailsSummary.current?.focus({ preventScroll: true });
    details.current.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  const wrapper = 'mx-auto max-w-7xl space-y-3 bg-slate-50 px-4 py-3 dark:bg-transparent sm:px-6';
  if (!ready) return <div data-material-view className={wrapper}>
    {backControl}
    <section className={`${surface} p-4`}><h1 className="mb-3 text-xl font-bold text-slate-900 dark:text-white">{materialQuery.status === 'error' ? 'Não foi possível abrir o material' : 'Abrindo material'}</h1>
      <MaterialResourceState resource={materialQuery} label="este material" />
      {materialQuery.status === 'error' && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Se continuar indisponível, peça ajuda à administração.</p>}
    </section>
  </div>;

  const material = materialQuery.data;
  const format = materialFormat(material);
  const fileUrl = materialFileUrl(material.file_path);
  const externalUrl = externalMaterialUrl(material.external_url);
  const metadata = [['Disciplina', material.discipline_name], ['Ano escolar', material.grade_name], ['Tipo', material.material_type_name],
    ['Formato', format], ['Duração', material.duration], ['Páginas', material.page_count], ['Adicionado em', materialDate(material.created_at)]].filter(([, value]) => value);

  return <div data-material-view className={wrapper}>
    <nav aria-label="Voltar à consulta">{backControl}</nav>
    <header className={`${surface} px-4 py-3 md:flex md:items-center md:gap-4`}>
      <div className="min-w-0 flex-1">
      <h1 className="break-words text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl">{material.title}</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{[material.discipline_name, material.grade_name, format].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 [&>button]:px-2 sm:[&>button]:px-3 md:mt-0 md:max-w-[50%]">
        <button type="button" className={button} disabled={action.busy || favorite.status !== 'ready'} aria-pressed={favorite.status === 'ready' ? favorite.data.favorited : undefined}
          aria-label={favorite.status === 'error' ? 'Favoritos indisponíveis' : favorite.status !== 'ready' ? 'Consultando favoritos' : favorite.data.favorited ? 'Remover dos favoritos' : 'Salvar nos favoritos'}
          onClick={() => action.run(async () => { const response = await api.post('/favorites/toggle', { material_id: id }, { timeout: 15000 }); parseFavorite(response.data); }, { refresh: favorite.retry, message: 'Favoritos atualizados.' })}>
          <Heart size={18} aria-hidden="true" className={favorite.data?.favorited ? 'fill-current' : ''} />{favorite.status === 'error' ? 'Favoritos indisponíveis' : favorite.status !== 'ready' ? 'Favoritos…' : favorite.data.favorited ? 'Nos favoritos' : 'Salvar favorito'}
        </button>
        {favorite.status === 'error' && <MaterialResourceState resource={favorite} label="seus favoritos" />}
        <button type="button" className={button} onClick={openDetails}><Info size={18} aria-hidden="true" />Detalhes</button>
        <ContentIssueButton targetType="material" targetId={material.id} targetLabel={material.title} />
        {externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className={button}><ExternalLink size={18} aria-hidden="true" />Abrir no site de origem</a>}
      </div>
    </header>

    <section aria-label="Leitura do material" data-material-reader className={`${surface} overflow-hidden`}>
      <MaterialPreview material={material} fileUrl={fileUrl} userRole={user?.role} restrictFeatures={user?.role === 'professor'} onRetry={materialQuery.retry} />
    </section>

    <details ref={details} onToggle={e => setDetailsOpen(e.currentTarget.open)} className={`${surface} scroll-mt-32`}>
      <summary ref={detailsSummary} className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 font-semibold text-slate-900 dark:text-white [&::-webkit-details-marker]:hidden ${focus}`}><Info size={18} aria-hidden="true" /><span className="flex-1">Sobre este material</span><ChevronDown size={18} aria-hidden="true" /></summary>
      <div className="space-y-4 border-t border-slate-200 p-4 dark:border-white/10">
        {detailsOpen && <MaterialSkills id={id} identity={identity} />}
        <p className="whitespace-pre-line break-words text-sm leading-6 text-slate-700 dark:text-slate-200">{material.description || 'Este material ainda não tem descrição.'}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">{metadata.map(([label, value]) => <div key={label}><dt className="text-slate-600 dark:text-slate-300">{label}</dt><dd className="break-words font-semibold text-slate-900 dark:text-white">{value}</dd></div>)}</dl>
        {!!material.topics?.length && <nav aria-label="Buscar materiais do mesmo assunto" className="flex flex-wrap gap-2">{material.topics.map(topic => <Link key={topic.id} to={`/biblioteca?topic_id=${encodeURIComponent(topic.id)}`} className={`${button} border border-slate-200 dark:border-white/10`}><span className="min-w-0 break-words">{topic.name}</span></Link>)}</nav>}
      </div>
    </details>
    {user?.role === 'admin' && <MaterialManagement id={id} identity={identity} fileUrl={fileUrl} action={action} />}
    <MaterialFeedback id={id} identity={identity} user={user} action={action} />
  </div>;
}
