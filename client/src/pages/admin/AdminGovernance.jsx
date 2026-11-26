import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon,
  FileClock,
  GitBranch,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react';
import AdminPageHeader from '../../components/admin/AdminPageHeader';
import ReleasesPanel from '../../components/admin/governance/ReleasesPanel';
import FeatureFlagsPanel from '../../components/admin/governance/FeatureFlagsPanel';
import PilotGroupsPanel from '../../components/admin/governance/PilotGroupsPanel';
import GovernanceAuditPanel from '../../components/admin/governance/GovernanceAuditPanel';
import governanceApi from '../../services/governanceApi';
import { useToast } from '../../contexts/ToastContext';
import { apiErrorMessage } from '../../components/admin/governance/GovernanceUi';

const tabs = [
  { id: 'releases', label: 'Releases', icon: GitBranch },
  { id: 'flags', label: 'Feature flags', icon: SlidersHorizontal },
  { id: 'groups', label: 'Grupos-piloto', icon: UsersRound },
  { id: 'audit', label: 'Auditoria', icon: FileClock },
];

export default function AdminGovernance() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('releases');
  const [releases, setReleases] = useState([]);
  const [flags, setFlags] = useState([]);
  const [groups, setGroups] = useState([]);
  const [audit, setAudit] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadData = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const [releaseData, flagData, groupData, auditData, userData] = await Promise.all([
        governanceApi.listReleases(),
        governanceApi.listFeatureFlags(),
        governanceApi.listPilotGroups(),
        governanceApi.listAudit(100),
        governanceApi.listUsers(),
      ]);
      setReleases(releaseData);
      setFlags(flagData);
      setGroups(groupData);
      setAudit(auditData);
      setUsers(userData);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const stats = useMemo(() => ({
    activeReleases: releases.filter((release) => ['pilot', 'rolling_out'].includes(release.status)).length,
    enabledFlags: flags.filter((flag) => flag.masterEnabled).length,
    killSwitches: flags.filter((flag) => flag.killSwitchActive).length,
    pilotBindings: flags.reduce((total, flag) => total + (flag.groupRuleCount || 0), 0),
  }), [flags, releases]);

  async function refresh() {
    await loadData({ silent: true });
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <AdminPageHeader
        icon={ShieldCheck}
        title="Governança de releases"
        description="Libere atualizações com grupos-piloto, percentuais controlados, auditoria e interrupção imediata quando necessário."
        action={(
          <button type="button" className="btn-ghost justify-center" onClick={refresh} disabled={refreshing || loading}>
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Atualizar
          </button>
        )}
      />

      {error ? (
        <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-ghost !border-red-200 justify-center" onClick={() => loadData()}>Tentar novamente</button>
        </div>
      ) : null}

      <div className="mb-5 rounded-2xl border border-cyan-200/80 bg-cyan-50/70 p-4 dark:border-cyan-400/20 dark:bg-cyan-400/[0.08]">
        <div className="flex gap-3">
          <ShieldCheck size={20} className="mt-0.5 flex-shrink-0 text-cyan-700 dark:text-cyan-200" />
          <div>
            <h2 className="text-sm font-black text-cyan-950 dark:text-cyan-100">Proteções aplicadas pelo backend</h2>
            <p className="mt-1 text-xs font-semibold leading-relaxed text-cyan-900/75 dark:text-cyan-100/75">
              Novas flags nascem desligadas. Motivos são obrigatórios, alterações concorrentes são bloqueadas e o kill switch prevalece sobre qualquer liberação.
            </p>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={GitBranch} label="Releases em validação" value={stats.activeReleases} tone="blue" />
        <StatCard icon={SlidersHorizontal} label="Mestres ligados" value={stats.enabledFlags} tone="emerald" />
        <StatCard icon={UsersRound} label="Vínculos em pilotos" value={stats.pilotBindings} tone="violet" />
        <StatCard icon={AlertOctagon} label="Kill switches ativos" value={stats.killSwitches} tone={stats.killSwitches ? 'red' : 'neutral'} />
      </div>

      <div className="mb-6 overflow-x-auto rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-sm dark:border-white/10 dark:bg-white/5">
        <div className="flex min-w-max gap-1" role="tablist" aria-label="Áreas de governança">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const count = tab.id === 'releases'
              ? releases.length
              : tab.id === 'flags'
                ? flags.length
                : tab.id === 'groups'
                  ? groups.length
                  : audit.length;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-black transition sm:px-4 ${activeTab === tab.id ? 'bg-primary-600 text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/8'}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={15} /> {tab.label}
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${activeTab === tab.id ? 'bg-white/20 text-white' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="space-y-4" aria-label="Carregando painel">
          {[1, 2, 3].map((item) => <div key={item} className="card h-36 animate-pulse bg-neutral-100 dark:bg-white/5" />)}
        </div>
      ) : (
        <div role="tabpanel">
          {activeTab === 'releases' ? <ReleasesPanel releases={releases} onRefresh={refresh} toast={toast} /> : null}
          {activeTab === 'flags' ? <FeatureFlagsPanel flags={flags} releases={releases} groups={groups} onRefresh={refresh} toast={toast} /> : null}
          {activeTab === 'groups' ? <PilotGroupsPanel groups={groups} users={users} onRefresh={refresh} toast={toast} /> : null}
          {activeTab === 'audit' ? <GovernanceAuditPanel audit={audit} /> : null}
        </div>
      )}
    </div>
  );
}

const statTones = {
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200',
  neutral: 'bg-neutral-100 text-neutral-500 dark:bg-white/8 dark:text-neutral-300',
};

function StatCard({ icon: Icon, label, value, tone }) {
  return (
    <div className="card flex items-center gap-3 p-3.5 sm:p-4">
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${statTones[tone]}`}><Icon size={18} /></div>
      <div className="min-w-0">
        <p className="text-xl font-black text-neutral-900 dark:text-white">{value}</p>
        <p className="truncate text-[10px] font-black uppercase tracking-wide text-neutral-400">{label}</p>
      </div>
    </div>
  );
}
