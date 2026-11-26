import { Component, lazy, Suspense, useState } from 'react';
import AssessmentDialog from './AssessmentDialog';
import { plannerResourcePath } from '../services/plannerResourcePreview.mjs';

const PlannerResourcePreview = lazy(() => import('./PlannerResourcePreview'));

class ResourcePreviewBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <div role="alert" className="space-y-2 text-amber-900 dark:text-amber-200">
      <p className="font-semibold">Não foi possível carregar a consulta.</p>
      <p>Feche a consulta e salve o planejamento, confirmando antes as escolhas pendentes. Depois, recarregue a página para tentar abrir o recurso novamente.</p>
    </div>;
    return this.props.children;
  }
}

export default function PlannerResourceButton({ resource }) {
  const [open, setOpen] = useState(false);
  if (resource.type === 'activity') return null;
  if (!plannerResourcePath(resource)) return <p className="text-sm text-slate-600 dark:text-slate-300">Recurso indisponível. O registro da aula foi mantido.</p>;
  return <>
    <button type="button" className="btn-outline min-h-11" aria-label={`Ver recurso: ${resource.title}`} onClick={() => setOpen(true)}>Ver recurso</button>
    {open && <AssessmentDialog title="Consultar recurso" wide onClose={() => setOpen(false)}>
      <div className="space-y-3 p-3 sm:p-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">Consulta do acervo atual. Ao fechar, sua edição e suas escolhas continuam no planejamento.</p>
        <ResourcePreviewBoundary>
          <Suspense fallback={<p role="status">Preparando a consulta…</p>}>
            <PlannerResourcePreview resource={resource} />
          </Suspense>
        </ResourcePreviewBoundary>
        <button type="button" className="btn-outline min-h-11" onClick={() => setOpen(false)}>Fechar consulta</button>
      </div>
    </AssessmentDialog>}
  </>;
}
