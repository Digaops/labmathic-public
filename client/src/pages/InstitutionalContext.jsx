import { useInstitutionalReadModel } from '../contexts/InstitutionalReadModelContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import ProfessionalInstitutionalContext from '../components/ProfessionalInstitutionalContext';
import InstitutionalNetwork from '../components/InstitutionalNetwork';

export default function InstitutionalContext() {
  const context = useInstitutionalReadModel();
  const { model, loading, error, refresh, identity } = context;
  const { isEnabled } = useFeatureFlags();
  const operationalPilot = isEnabled('institutions.management_pilot');
  if (loading || !model) return <div data-institutional-network style={{ maxWidth: '48rem' }} className="mx-auto px-3 py-4 text-sm text-slate-700 dark:text-slate-200">
    <h1 className="text-xl font-bold">Escolas e rede</h1>
    {loading ? <p className="mt-3" role="status">Consultando a rede…</p> : <div className="mt-3" role="alert"><p>{error || 'A consulta da rede não está disponível nesta conta.'}</p><button className="mt-2 min-h-11 rounded-xl border px-3" onClick={refresh}>Tentar novamente</button></div>}
  </div>;
  if (model.mode === 'professional') return <div key={identity}>
    {error && <p role="alert" className="px-4 pt-3 text-sm text-amber-800 dark:text-amber-200">{error} Os dados abaixo são da última consulta. <button type="button" className="min-h-11 underline" onClick={refresh}>Tentar novamente</button></p>}
    <ProfessionalInstitutionalContext model={model} operationalPilot={operationalPilot} onChanged={refresh} />
  </div>;
  return <InstitutionalNetwork key={identity} {...context} operationalPilot={operationalPilot} />;
}
