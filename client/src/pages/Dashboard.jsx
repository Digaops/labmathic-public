import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { useInstitutionalReadModel } from '../contexts/InstitutionalReadModelContext';
import TeacherHome from '../components/TeacherHome';
import AdministrativeHome from '../components/AdministrativeHome';
import InstitutionalHome, { HomeContextStatus } from '../components/InstitutionalHome';
import { dashboardHomeState } from '../services/dashboardHome.mjs';

export default function Dashboard() {
  const { isAdmin } = useAuth();
  const flags = useFeatureFlags();
  const institutional = useInstitutionalReadModel();
  const state = dashboardHomeState({ isAdmin, flags, institutional });
  if (state === 'loading' || state === 'unavailable') return <HomeContextStatus state={state} onRetry={() => { flags.refresh(); institutional.refresh(); }} />;
  if (state === 'manager') return <InstitutionalHome model={institutional.model} features={flags.features} error={institutional.error} refreshing={institutional.refreshing} onRefresh={institutional.refresh} />;
  return isAdmin ? <AdministrativeHome /> : <TeacherHome />;
}
