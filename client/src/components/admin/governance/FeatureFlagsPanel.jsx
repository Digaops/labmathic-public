import { useMemo, useState } from 'react';
import {
  AlertOctagon,
  FlaskConical,
  Gauge,
  Plus,
  Settings2,
  ShieldOff,
  SlidersHorizontal,
  Trash2,
  UsersRound,
} from 'lucide-react';
import Modal from '../../Modal';
import governanceApi from '../../../services/governanceApi';
import {
  ApiError,
  Field,
  ModalActions,
  ReasonField,
  SafetyNote,
  StatusBadge,
  Toggle,
  apiErrorMessage,
} from './GovernanceUi';

const emptyCreate = { key: '', name: '', description: '', release_id: '', reason: '' };

export default function FeatureFlagsPanel({ flags, releases, groups, onRefresh, toast }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [configuring, setConfiguring] = useState(null);
  const [configForm, setConfigForm] = useState(null);
  const [killFlag, setKillFlag] = useState(null);
  const [killForm, setKillForm] = useState({ reason: '', confirmation: '' });
  const [pilotFlag, setPilotFlag] = useState(null);
  const [rules, setRules] = useState(null);
  const [ruleForm, setRuleForm] = useState({ groupId: '', enabled: true, reason: '' });
  const [saving, setSaving] = useState(false);
  const [loadingRules, setLoadingRules] = useState(false);
  const [error, setError] = useState('');

  const availableGroups = useMemo(() => {
    const assigned = new Set((rules?.groupRules || []).map((rule) => rule.group_id));
    return groups.filter((group) => !assigned.has(group.id));
  }, [groups, rules]);

  function openConfig(flag) {
    setConfiguring(flag);
    setConfigForm({
      name: flag.name,
      description: flag.description || '',
      release_id: flag.releaseId || '',
      master_enabled: flag.masterEnabled,
      default_enabled: flag.defaultEnabled,
      rollout_percentage: flag.rolloutPercentage,
      reason: '',
    });
    setError('');
  }

  function openKillSwitch(flag) {
    setKillFlag(flag);
    setKillForm({ reason: '', confirmation: '' });
    setError('');
  }

  async function openPilots(flag) {
    setPilotFlag(flag);
    setRules(null);
    setRuleForm({ groupId: '', enabled: true, reason: '' });
    setError('');
    setLoadingRules(true);
    try {
      setRules(await governanceApi.getFeatureFlagRules(flag.id));
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setLoadingRules(false);
    }
  }

  async function refreshRules(flagId = pilotFlag?.id) {
    if (!flagId) return;
    setRules(await governanceApi.getFeatureFlagRules(flagId));
  }

  async function createFlag(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.createFeatureFlag({
        ...createForm,
        release_id: createForm.release_id ? Number(createForm.release_id) : null,
      });
      toast.success('Feature flag criada desligada por padrão.');
      setCreateForm(emptyCreate);
      setCreateOpen(false);
      await onRefresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function saveConfig(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.updateFeatureFlag(configuring.id, {
        ...configForm,
        release_id: configForm.release_id ? Number(configForm.release_id) : null,
        rollout_percentage: Number(configForm.rollout_percentage),
        expected_revision: configuring.revision,
      });
      toast.success('Configuração atualizada com revisão e auditoria.');
      setConfiguring(null);
      setConfigForm(null);
      await onRefresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function toggleKillSwitch(event) {
    event.preventDefault();
    const activating = !killFlag.killSwitchActive;
    setSaving(true);
    setError('');
    try {
      await governanceApi.toggleKillSwitch(killFlag.id, {
        active: activating,
        expected_revision: killFlag.revision,
        reason: killForm.reason,
      });
      toast[activating ? 'warning' : 'success'](
        activating
          ? 'Kill switch acionado. A funcionalidade foi desligada imediatamente.'
          : 'Kill switch desativado. As demais regras voltaram a ser avaliadas.'
      );
      setKillFlag(null);
      await onRefresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function addGroupRule(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.setPilotGroupRule(
        pilotFlag.id,
        Number(ruleForm.groupId),
        { enabled: ruleForm.enabled, reason: ruleForm.reason }
      );
      toast.success('Regra do grupo-piloto registrada.');
      setRuleForm({ groupId: '', enabled: true, reason: '' });
      await Promise.all([refreshRules(), onRefresh()]);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function removeGroupRule(rule) {
    if (ruleForm.reason.trim().length < 10) {
      setError('Informe no campo de motivo por que a regra será removida.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await governanceApi.removePilotGroupRule(pilotFlag.id, rule.group_id, ruleForm.reason);
      toast.success('Regra do grupo removida; o usuário voltará a seguir as demais regras.');
      await Promise.all([refreshRules(), onRefresh()]);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="flags-title">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="flags-title" className="text-lg font-black text-neutral-900 dark:text-white">Feature flags</h2>
          <p className="mt-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Libere funcionalidades por piloto ou percentual sem novo deploy.
          </p>
        </div>
        <button type="button" className="btn-primary justify-center" onClick={() => { setError(''); setCreateOpen(true); }}>
          <Plus size={16} /> Nova feature flag
        </button>
      </div>

      {flags.length === 0 ? (
        <div className="card border-dashed p-8 text-center">
          <SlidersHorizontal size={28} className="mx-auto text-neutral-400" />
          <h3 className="mt-3 font-black text-neutral-800 dark:text-neutral-100">Nenhuma flag cadastrada</h3>
          <p className="mt-1 text-sm font-medium text-neutral-500 dark:text-neutral-400">Crie a primeira flag; ela nascerá totalmente desligada.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {flags.map((flag) => (
            <article key={flag.id} className={`card overflow-hidden ${flag.killSwitchActive ? '!border-red-300 dark:!border-red-500/40' : ''}`}>
              {flag.killSwitchActive ? (
                <div className="flex items-center gap-2 bg-red-600 px-4 py-2 text-xs font-black text-white">
                  <AlertOctagon size={15} /> Kill switch ativo · funcionalidade indisponível
                </div>
              ) : null}
              <div className="p-4 sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${flag.masterEnabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' : 'bg-neutral-100 text-neutral-500 dark:bg-white/8 dark:text-neutral-300'}`}>
                      {flag.masterEnabled ? <Gauge size={20} /> : <ShieldOff size={20} />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-black text-neutral-900 dark:text-white">{flag.name}</h3>
                        <span className={`rounded-full px-2 py-1 text-[10px] font-black ${flag.masterEnabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' : 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300'}`}>
                          {flag.masterEnabled ? 'Mestre ligado' : 'Mestre desligado'}
                        </span>
                      </div>
                      <code className="mt-1 block truncate text-xs font-bold text-primary-600 dark:text-cyan-300">{flag.key}</code>
                      {flag.description ? <p className="mt-2 text-xs font-medium leading-relaxed text-neutral-500 dark:text-neutral-400">{flag.description}</p> : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => openPilots(flag)}>
                      <UsersRound size={14} /> Pilotos ({flag.groupRuleCount || 0})
                    </button>
                    <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => openConfig(flag)}>
                      <Settings2 size={14} /> Configurar
                    </button>
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-black transition ${flag.killSwitchActive ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'}`}
                      onClick={() => openKillSwitch(flag)}
                    >
                      <AlertOctagon size={14} /> {flag.killSwitchActive ? 'Reavaliar ativação' : 'Kill switch'}
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl bg-neutral-50 p-3 dark:bg-white/5">
                    <p className="text-[10px] font-black uppercase tracking-wide text-neutral-400">Release</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-black text-neutral-800 dark:text-neutral-100">{flag.releaseVersion ? `v${flag.releaseVersion}` : 'Sem vínculo'}</span>
                      {flag.releaseStatus ? <StatusBadge status={flag.releaseStatus} /> : null}
                    </div>
                  </div>
                  <div className="rounded-xl bg-neutral-50 p-3 dark:bg-white/5">
                    <p className="text-[10px] font-black uppercase tracking-wide text-neutral-400">Rollout</p>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
                        <div className="h-full rounded-full bg-primary-500" style={{ width: `${flag.rolloutPercentage}%` }} />
                      </div>
                      <span className="text-xs font-black text-neutral-700 dark:text-neutral-200">{flag.rolloutPercentage}%</span>
                    </div>
                  </div>
                  <div className="rounded-xl bg-neutral-50 p-3 dark:bg-white/5">
                    <p className="text-[10px] font-black uppercase tracking-wide text-neutral-400">Fallback</p>
                    <p className="mt-1.5 text-xs font-black text-neutral-800 dark:text-neutral-100">{flag.defaultEnabled ? 'Ativo para os demais' : 'Desligado para os demais'}</p>
                    <p className="mt-1 text-[10px] font-semibold text-neutral-400">Revisão #{flag.revision}</p>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => !saving && setCreateOpen(false)} title="Criar feature flag" maxWidth="max-w-xl">
        <form onSubmit={createFlag} className="space-y-4">
          <SafetyNote>A nova flag nasce com ativação mestre desligada, default desligado e rollout em 0%.</SafetyNote>
          <Field label="Chave técnica" hint="Minúsculas, sem espaços. A chave não poderá ser editada depois." required>
            <input className="input font-mono" maxLength={64} value={createForm.key} onChange={(e) => setCreateForm((form) => ({ ...form, key: e.target.value.toLowerCase().replace(/\s+/g, '_') }))} placeholder="turmas.nova_experiencia" required />
          </Field>
          <Field label="Nome amigável" required>
            <input className="input" maxLength={120} value={createForm.name} onChange={(e) => setCreateForm((form) => ({ ...form, name: e.target.value }))} placeholder="Nova experiência de turmas" required />
          </Field>
          <Field label="Release vinculada">
            <select className="select" value={createForm.release_id} onChange={(e) => setCreateForm((form) => ({ ...form, release_id: e.target.value }))}>
              <option value="">Sem vínculo</option>
              {releases.map((release) => <option key={release.id} value={release.id}>v{release.version} · {release.name || release.title}</option>)}
            </select>
          </Field>
          <Field label="Descrição">
            <textarea className="input min-h-20 resize-y" maxLength={2000} value={createForm.description} onChange={(e) => setCreateForm((form) => ({ ...form, description: e.target.value }))} />
          </Field>
          <ReasonField value={createForm.reason} onChange={(reason) => setCreateForm((form) => ({ ...form, reason }))} label="Motivo da criação" />
          <ApiError message={error} />
          <ModalActions onCancel={() => setCreateOpen(false)} saving={saving} submitLabel="Criar desligada" disabled={createForm.reason.trim().length < 10} />
        </form>
      </Modal>

      <Modal open={Boolean(configuring)} onClose={() => !saving && setConfiguring(null)} title={configuring ? `Configurar ${configuring.name}` : ''} maxWidth="max-w-2xl">
        {configuring && configForm ? (
          <form onSubmit={saveConfig} className="space-y-4">
            <SafetyNote>O backend continuará aplicando o estado da release, as regras de piloto e o kill switch, mesmo que a interface seja manipulada.</SafetyNote>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome" required>
                <input className="input" maxLength={120} value={configForm.name} onChange={(e) => setConfigForm((form) => ({ ...form, name: e.target.value }))} required />
              </Field>
              <Field label="Release vinculada">
                <select className="select" value={configForm.release_id} onChange={(e) => setConfigForm((form) => ({ ...form, release_id: e.target.value }))}>
                  <option value="">Sem vínculo</option>
                  {releases.map((release) => <option key={release.id} value={release.id}>v{release.version} · {release.title}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Descrição">
              <textarea className="input min-h-20 resize-y" maxLength={2000} value={configForm.description} onChange={(e) => setConfigForm((form) => ({ ...form, description: e.target.value }))} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Toggle checked={configForm.master_enabled} onChange={(value) => setConfigForm((form) => ({ ...form, master_enabled: value }))} label="Ativação mestre" description="Permite que as demais regras sejam avaliadas. Sozinha não garante acesso." />
              <Toggle checked={configForm.default_enabled} disabled={Number(configForm.rollout_percentage) > 0 && Number(configForm.rollout_percentage) < 100} onChange={(value) => setConfigForm((form) => ({ ...form, default_enabled: value }))} label="Fallback ativo" description="Use somente para disponibilidade geral; não combine com rollout parcial." />
            </div>
            <Field label={`Percentual de rollout · ${configForm.rollout_percentage}%`} hint="O mesmo usuário permanece sempre no mesmo bucket.">
              <div className="flex items-center gap-3">
                <input type="range" min="0" max="100" step="1" className="min-w-0 flex-1 accent-primary-600" value={configForm.rollout_percentage} onChange={(e) => setConfigForm((form) => ({ ...form, rollout_percentage: Number(e.target.value), default_enabled: Number(e.target.value) > 0 && Number(e.target.value) < 100 ? false : form.default_enabled }))} />
                <div className="relative w-24 shrink-0">
                  <input
                    aria-label="Percentual exato de rollout"
                    className="input pr-8 text-right"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={configForm.rollout_percentage}
                    onChange={(e) => {
                      const percentage = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                      setConfigForm((form) => ({
                        ...form,
                        rollout_percentage: percentage,
                        default_enabled: percentage > 0 && percentage < 100 ? false : form.default_enabled,
                      }));
                    }}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-neutral-400">%</span>
                </div>
              </div>
              <div className="mt-1 flex justify-between text-[10px] font-bold text-neutral-400"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
            </Field>
            <ReasonField value={configForm.reason} onChange={(reason) => setConfigForm((form) => ({ ...form, reason }))} />
            <ApiError message={error} />
            <ModalActions onCancel={() => setConfiguring(null)} saving={saving} disabled={configForm.reason.trim().length < 10} />
          </form>
        ) : null}
      </Modal>

      <Modal open={Boolean(killFlag)} onClose={() => !saving && setKillFlag(null)} title={killFlag?.killSwitchActive ? 'Desativar kill switch' : 'Acionar kill switch'} maxWidth="max-w-lg">
        {killFlag ? (
          <form onSubmit={toggleKillSwitch} className="space-y-4">
            <SafetyNote danger={!killFlag.killSwitchActive}>
              {killFlag.killSwitchActive
                ? 'Ao desativar, o sistema voltará a avaliar release, regras individuais, grupos e percentual.'
                : 'Esta ação desliga imediatamente a funcionalidade para todos, independentemente de qualquer outra regra.'}
            </SafetyNote>
            <ReasonField value={killForm.reason} onChange={(reason) => setKillForm((form) => ({ ...form, reason }))} label="Motivo operacional" />
            <Field label={`Digite ${killFlag.killSwitchActive ? 'REATIVAR' : 'DESLIGAR'} para confirmar`} required>
              <input className="input font-black uppercase" value={killForm.confirmation} onChange={(e) => setKillForm((form) => ({ ...form, confirmation: e.target.value.toUpperCase() }))} autoComplete="off" />
            </Field>
            <ApiError message={error} />
            <ModalActions
              onCancel={() => setKillFlag(null)}
              saving={saving}
              danger={!killFlag.killSwitchActive}
              submitLabel={killFlag.killSwitchActive ? 'Desativar e reavaliar regras' : 'Desligar imediatamente'}
              disabled={killForm.reason.trim().length < 10 || killForm.confirmation !== (killFlag.killSwitchActive ? 'REATIVAR' : 'DESLIGAR')}
            />
          </form>
        ) : null}
      </Modal>

      <Modal open={Boolean(pilotFlag)} onClose={() => !saving && setPilotFlag(null)} title={pilotFlag ? `Grupos-piloto · ${pilotFlag.name}` : ''} maxWidth="max-w-2xl">
        {loadingRules ? <p className="py-8 text-center text-sm font-bold text-neutral-500">Carregando regras...</p> : (
          <div className="space-y-4">
            <SafetyNote>Uma regra de bloqueio de grupo prevalece quando o mesmo usuário pertence a mais de um grupo vinculado.</SafetyNote>
            <div className="space-y-2">
              {(rules?.groupRules || []).map((rule) => (
                <div key={rule.id} className="flex flex-col gap-3 rounded-2xl border border-neutral-200 p-3.5 dark:border-white/10 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-black text-neutral-800 dark:text-neutral-100">{rule.group_name}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${rule.enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200'}`}>{rule.enabled ? 'Liberado' : 'Bloqueado'}</span>
                      {!rule.group_active ? <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-black text-neutral-500 dark:bg-white/10 dark:text-neutral-300">Grupo inativo</span> : null}
                    </div>
                    <p className="mt-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">{rule.member_count} membro(s) · {rule.reason}</p>
                  </div>
                  <button type="button" className="btn-ghost !px-3 !py-2 text-xs text-red-600" onClick={() => removeGroupRule(rule)} disabled={saving || ruleForm.reason.trim().length < 10} title="Preencha o motivo abaixo antes de remover">
                    <Trash2 size={14} /> Remover
                  </button>
                </div>
              ))}
              {rules?.groupRules?.length === 0 ? <p className="rounded-2xl border border-dashed border-neutral-200 p-5 text-center text-sm font-medium text-neutral-500 dark:border-white/10 dark:text-neutral-400">Nenhum grupo vinculado a esta flag.</p> : null}
            </div>

            <form onSubmit={addGroupRule} className="space-y-4 rounded-2xl bg-neutral-50 p-4 dark:bg-white/5">
              <div className="flex items-center gap-2 text-sm font-black text-neutral-800 dark:text-neutral-100"><FlaskConical size={16} /> Vincular grupo</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Grupo-piloto" required>
                  <select className="select" value={ruleForm.groupId} onChange={(e) => setRuleForm((form) => ({ ...form, groupId: e.target.value }))} required>
                    <option value="">Selecione...</option>
                    {availableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}{group.active ? '' : ' · inativo'}</option>)}
                  </select>
                </Field>
                <Toggle checked={ruleForm.enabled} onChange={(enabled) => setRuleForm((form) => ({ ...form, enabled }))} label={ruleForm.enabled ? 'Liberar este grupo' : 'Bloquear este grupo'} description="A decisão só vale enquanto o grupo estiver ativo." danger={!ruleForm.enabled} />
              </div>
              <ReasonField value={ruleForm.reason} onChange={(reason) => setRuleForm((form) => ({ ...form, reason }))} label="Motivo da regra ou remoção" />
              <ApiError message={error} />
              <div className="flex justify-end">
                <button type="submit" className="btn-primary justify-center" disabled={saving || !ruleForm.groupId || ruleForm.reason.trim().length < 10}>{saving ? 'Salvando...' : 'Vincular grupo'}</button>
              </div>
            </form>
          </div>
        )}
      </Modal>
    </section>
  );
}
