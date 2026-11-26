import { useState } from 'react';
import { CalendarClock, GitBranch, Pencil, Plus, ShieldCheck } from 'lucide-react';
import Modal from '../../Modal';
import governanceApi from '../../../services/governanceApi';
import {
  ApiError,
  Field,
  ModalActions,
  ReasonField,
  SafetyNote,
  StatusBadge,
  apiErrorMessage,
  formatDate,
  releaseStatus,
  releaseTransitions,
} from './GovernanceUi';

const emptyCreate = { version: '', title: '', description: '', reason: '' };

export default function ReleasesPanel({ releases, onRefresh, toast }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function openEdit(release) {
    setEditing(release);
    setEditForm({
      title: release.title,
      description: release.description || '',
      status: release.status,
      reason: '',
    });
    setError('');
  }

  async function createRelease(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.createRelease(createForm);
      toast.success('Release criada em modo rascunho e sem funcionalidades liberadas.');
      setCreateForm(emptyCreate);
      setCreateOpen(false);
      await onRefresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function updateRelease(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.updateRelease(editing.id, {
        ...editForm,
        expected_revision: editing.revision,
      });
      toast.success('Release atualizada com registro na auditoria.');
      setEditing(null);
      setEditForm(null);
      await onRefresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="releases-title">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="releases-title" className="text-lg font-black text-neutral-900 dark:text-white">Releases registradas</h2>
          <p className="mt-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Controle o estágio de cada versão sem liberar funcionalidades automaticamente.
          </p>
        </div>
        <button type="button" className="btn-primary justify-center" onClick={() => { setError(''); setCreateOpen(true); }}>
          <Plus size={16} /> Nova release
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {releases.map((release) => (
          <article key={release.id} className="card p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600 dark:bg-cyan-400/10 dark:text-cyan-200">
                <GitBranch size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-black text-neutral-900 dark:text-white">v{release.version}</h3>
                  <StatusBadge status={release.status} />
                </div>
                <p className="mt-1 text-sm font-bold text-neutral-700 dark:text-neutral-200">{release.title}</p>
                {release.description ? (
                  <p className="mt-2 line-clamp-2 text-xs font-medium leading-relaxed text-neutral-500 dark:text-neutral-400">{release.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="btn-ghost !p-2"
                onClick={() => openEdit(release)}
                aria-label={`Editar release ${release.version}`}
              >
                <Pencil size={15} />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 rounded-2xl bg-neutral-50 p-3 dark:bg-white/5">
              <div>
                <p className="text-[10px] font-black uppercase tracking-wide text-neutral-400">Feature flags</p>
                <p className="mt-1 text-sm font-black text-neutral-800 dark:text-neutral-100">{release.featureFlagCount || 0}</p>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-wide text-neutral-400">Revisão</p>
                <p className="mt-1 text-sm font-black text-neutral-800 dark:text-neutral-100">#{release.revision}</p>
              </div>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">
              <CalendarClock size={13} /> {formatDate(release.releasedAt || release.createdAt)}
            </p>
          </article>
        ))}
      </div>

      <Modal open={createOpen} onClose={() => !saving && setCreateOpen(false)} title="Registrar nova release" maxWidth="max-w-xl">
        <form onSubmit={createRelease} className="space-y-4">
          <SafetyNote>
            A release será criada como rascunho. Nenhuma funcionalidade será disponibilizada até a configuração explícita das flags.
          </SafetyNote>
          <div className="grid gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
            <Field label="Versão" hint="Use versionamento semântico, como 1.6.0." required>
              <input className="input" value={createForm.version} onChange={(e) => setCreateForm((form) => ({ ...form, version: e.target.value }))} placeholder="1.6.0" required />
            </Field>
            <Field label="Título" required>
              <input className="input" maxLength={120} value={createForm.title} onChange={(e) => setCreateForm((form) => ({ ...form, title: e.target.value }))} placeholder="Fundação institucional" required />
            </Field>
          </div>
          <Field label="Descrição">
            <textarea className="input min-h-20 resize-y" maxLength={2000} value={createForm.description} onChange={(e) => setCreateForm((form) => ({ ...form, description: e.target.value }))} placeholder="Escopo e objetivo desta versão." />
          </Field>
          <ReasonField value={createForm.reason} onChange={(reason) => setCreateForm((form) => ({ ...form, reason }))} label="Motivo do registro" />
          <ApiError message={error} />
          <ModalActions onCancel={() => setCreateOpen(false)} saving={saving} submitLabel="Criar como rascunho" disabled={createForm.reason.trim().length < 10} />
        </form>
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => !saving && setEditing(null)} title={editing ? `Gerenciar release v${editing.version}` : ''} maxWidth="max-w-xl">
        {editing && editForm ? (
          <form onSubmit={updateRelease} className="space-y-4">
            {(editForm.status === 'paused' || editForm.status === 'retired') && editForm.status !== editing.status ? (
              <SafetyNote danger>
                Ao salvar, todas as feature flags vinculadas a esta release ficarão desligadas imediatamente.
              </SafetyNote>
            ) : (
              <SafetyNote>
                Alterar o estágio não liga a ativação mestre das flags. Cada funcionalidade continua sob controle individual.
              </SafetyNote>
            )}
            <Field label="Título" required>
              <input className="input" maxLength={120} value={editForm.title} onChange={(e) => setEditForm((form) => ({ ...form, title: e.target.value }))} required />
            </Field>
            <Field label="Estágio" hint="As opções exibidas respeitam as transições permitidas pelo backend." required>
              <select className="select" value={editForm.status} onChange={(e) => setEditForm((form) => ({ ...form, status: e.target.value }))}>
                {releaseTransitions[editing.status].map((status) => (
                  <option key={status} value={status}>{releaseStatus[status].label}</option>
                ))}
              </select>
            </Field>
            <Field label="Descrição">
              <textarea className="input min-h-20 resize-y" maxLength={2000} value={editForm.description} onChange={(e) => setEditForm((form) => ({ ...form, description: e.target.value }))} />
            </Field>
            <ReasonField value={editForm.reason} onChange={(reason) => setEditForm((form) => ({ ...form, reason }))} />
            <ApiError message={error} />
            <ModalActions onCancel={() => setEditing(null)} saving={saving} disabled={editForm.reason.trim().length < 10} />
          </form>
        ) : null}
      </Modal>
    </section>
  );
}
