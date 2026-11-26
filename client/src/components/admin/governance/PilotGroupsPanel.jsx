import { useMemo, useState } from 'react';
import { Pencil, Plus, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import Modal from '../../Modal';
import governanceApi from '../../../services/governanceApi';
import {
  ApiError,
  Field,
  ModalActions,
  ReasonField,
  SafetyNote,
  Toggle,
  apiErrorMessage,
  formatDate,
} from './GovernanceUi';

const emptyCreate = { key: '', name: '', description: '', reason: '' };

export default function PilotGroupsPanel({ groups, users, onRefresh, toast }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [managedGroup, setManagedGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberForm, setMemberForm] = useState({ userId: '', reason: '' });
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeReason, setRemoveReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const availableUsers = useMemo(() => {
    const ids = new Set(members.map((member) => member.id));
    return users.filter((user) => !ids.has(user.id));
  }, [users, members]);

  function openEdit(group) {
    setEditing(group);
    setEditForm({
      name: group.name,
      description: group.description || '',
      active: group.active,
      reason: '',
    });
    setError('');
  }

  async function loadMembers(group) {
    setManagedGroup(group);
    setMembers([]);
    setMemberForm({ userId: '', reason: '' });
    setError('');
    setMembersLoading(true);
    try {
      setMembers(await governanceApi.listPilotGroupMembers(group.id));
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setMembersLoading(false);
    }
  }

  async function refreshMembers() {
    if (!managedGroup) return;
    setMembers(await governanceApi.listPilotGroupMembers(managedGroup.id));
  }

  async function createGroup(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.createPilotGroup(createForm);
      toast.success('Grupo-piloto criado sem membros e sem acesso a funcionalidades.');
      setCreateForm(emptyCreate);
      setCreateOpen(false);
      await onRefresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function updateGroup(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.updatePilotGroup(editing.id, {
        ...editForm,
        expected_revision: editing.revision,
      });
      toast.success(editForm.active ? 'Grupo-piloto atualizado.' : 'Grupo desativado; suas regras deixaram de ser avaliadas.');
      setEditing(null);
      setEditForm(null);
      await onRefresh();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function addMember(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.addPilotGroupMember(managedGroup.id, {
        user_id: Number(memberForm.userId),
        reason: memberForm.reason,
      });
      toast.success('Usuário adicionado ao grupo-piloto com registro de auditoria.');
      setMemberForm({ userId: '', reason: '' });
      await Promise.all([refreshMembers(), onRefresh()]);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function removeMember(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await governanceApi.removePilotGroupMember(managedGroup.id, removeTarget.id, removeReason);
      toast.success('Usuário removido do grupo; o acesso será reavaliado pelas demais regras.');
      setRemoveTarget(null);
      setRemoveReason('');
      await Promise.all([refreshMembers(), onRefresh()]);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="groups-title">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="groups-title" className="text-lg font-black text-neutral-900 dark:text-white">Grupos-piloto</h2>
          <p className="mt-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Organize pessoas selecionadas sem repetir regras individuais em cada flag.
          </p>
        </div>
        <button type="button" className="btn-primary justify-center" onClick={() => { setError(''); setCreateOpen(true); }}>
          <Plus size={16} /> Novo grupo-piloto
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="card border-dashed p-8 text-center">
          <UsersRound size={28} className="mx-auto text-neutral-400" />
          <h3 className="mt-3 font-black text-neutral-800 dark:text-neutral-100">Nenhum grupo-piloto</h3>
          <p className="mt-1 text-sm font-medium text-neutral-500 dark:text-neutral-400">Crie um grupo e adicione os primeiros usuários selecionados.</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((group) => (
            <article key={group.id} className={`card p-5 ${!group.active ? 'opacity-75' : ''}`}>
              <div className="flex items-start gap-3">
                <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${group.active ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200' : 'bg-neutral-100 text-neutral-500 dark:bg-white/8 dark:text-neutral-300'}`}>
                  <UsersRound size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-black text-neutral-900 dark:text-white">{group.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${group.active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' : 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300'}`}>{group.active ? 'Ativo' : 'Inativo'}</span>
                  </div>
                  <code className="mt-1 block truncate text-xs font-bold text-violet-600 dark:text-violet-300">{group.key}</code>
                  {group.description ? <p className="mt-2 line-clamp-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">{group.description}</p> : null}
                </div>
                <button type="button" className="btn-ghost !p-2" onClick={() => openEdit(group)} aria-label={`Editar grupo ${group.name}`}>
                  <Pencil size={15} />
                </button>
              </div>

              <div className="mt-4 flex items-center justify-between rounded-2xl bg-neutral-50 p-3 dark:bg-white/5">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-wide text-neutral-400">Membros selecionados</p>
                  <p className="mt-1 text-xl font-black text-neutral-900 dark:text-white">{group.memberCount || 0}</p>
                </div>
                <button type="button" className="btn-secondary !px-3 !py-2 text-xs" onClick={() => loadMembers(group)}>
                  <UserPlus size={14} /> Gerenciar membros
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => !saving && setCreateOpen(false)} title="Criar grupo-piloto" maxWidth="max-w-xl">
        <form onSubmit={createGroup} className="space-y-4">
          <SafetyNote>O grupo nasce ativo, mas sem membros e sem vínculo com feature flags.</SafetyNote>
          <Field label="Chave técnica" hint="Não poderá ser alterada depois." required>
            <input className="input font-mono" maxLength={64} value={createForm.key} onChange={(e) => setCreateForm((form) => ({ ...form, key: e.target.value.toLowerCase().replace(/\s+/g, '_') }))} placeholder="professores_piloto" required />
          </Field>
          <Field label="Nome" required>
            <input className="input" maxLength={120} value={createForm.name} onChange={(e) => setCreateForm((form) => ({ ...form, name: e.target.value }))} placeholder="Professores do piloto inicial" required />
          </Field>
          <Field label="Descrição">
            <textarea className="input min-h-20 resize-y" maxLength={2000} value={createForm.description} onChange={(e) => setCreateForm((form) => ({ ...form, description: e.target.value }))} />
          </Field>
          <ReasonField value={createForm.reason} onChange={(reason) => setCreateForm((form) => ({ ...form, reason }))} label="Motivo da criação" />
          <ApiError message={error} />
          <ModalActions onCancel={() => setCreateOpen(false)} saving={saving} submitLabel="Criar grupo vazio" disabled={createForm.reason.trim().length < 10} />
        </form>
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => !saving && setEditing(null)} title={editing ? `Editar ${editing.name}` : ''} maxWidth="max-w-xl">
        {editing && editForm ? (
          <form onSubmit={updateGroup} className="space-y-4">
            {!editForm.active && editing.active ? (
              <SafetyNote danger>Desativar o grupo interrompe imediatamente todas as regras vinculadas a ele, sem excluir membros.</SafetyNote>
            ) : null}
            <Field label="Nome" required>
              <input className="input" maxLength={120} value={editForm.name} onChange={(e) => setEditForm((form) => ({ ...form, name: e.target.value }))} required />
            </Field>
            <Field label="Descrição">
              <textarea className="input min-h-20 resize-y" maxLength={2000} value={editForm.description} onChange={(e) => setEditForm((form) => ({ ...form, description: e.target.value }))} />
            </Field>
            <Toggle checked={editForm.active} onChange={(active) => setEditForm((form) => ({ ...form, active }))} label={editForm.active ? 'Grupo ativo' : 'Grupo inativo'} description="Grupos inativos permanecem registrados, mas não participam da avaliação das flags." danger={!editForm.active} />
            <ReasonField value={editForm.reason} onChange={(reason) => setEditForm((form) => ({ ...form, reason }))} />
            <ApiError message={error} />
            <ModalActions onCancel={() => setEditing(null)} saving={saving} danger={!editForm.active && editing.active} disabled={editForm.reason.trim().length < 10} />
          </form>
        ) : null}
      </Modal>

      <Modal open={Boolean(managedGroup)} onClose={() => !saving && setManagedGroup(null)} title={managedGroup ? `Membros · ${managedGroup.name}` : ''} maxWidth="max-w-2xl">
        {membersLoading ? <p className="py-8 text-center text-sm font-bold text-neutral-500">Carregando membros...</p> : (
          <div className="space-y-4">
            <SafetyNote>Entrar em um grupo não garante acesso sozinho: a flag precisa estar ligada e vinculada a este grupo.</SafetyNote>
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {members.map((member) => (
                <div key={member.id} className="flex items-center gap-3 rounded-2xl border border-neutral-200 p-3 dark:border-white/10">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-violet-100 text-xs font-black text-violet-700 dark:bg-violet-500/15 dark:text-violet-200">{member.name?.charAt(0)?.toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black text-neutral-800 dark:text-neutral-100">{member.name}</p>
                    <p className="truncate text-[11px] font-medium text-neutral-500 dark:text-neutral-400">{member.email} · {member.role === 'admin' ? 'Administrador' : 'Professor'} · desde {formatDate(member.added_at)}</p>
                  </div>
                  <button type="button" className="btn-ghost !p-2 text-red-600" onClick={() => { setRemoveTarget(member); setRemoveReason(''); setError(''); }} aria-label={`Remover ${member.name}`}>
                    <UserMinus size={15} />
                  </button>
                </div>
              ))}
              {members.length === 0 ? <p className="rounded-2xl border border-dashed border-neutral-200 p-5 text-center text-sm font-medium text-neutral-500 dark:border-white/10 dark:text-neutral-400">Este grupo ainda não possui membros.</p> : null}
            </div>

            <form onSubmit={addMember} className="space-y-4 rounded-2xl bg-neutral-50 p-4 dark:bg-white/5">
              <div className="flex items-center gap-2 text-sm font-black text-neutral-800 dark:text-neutral-100"><UserPlus size={16} /> Adicionar usuário</div>
              <Field label="Usuário" required>
                <select className="select" value={memberForm.userId} onChange={(e) => setMemberForm((form) => ({ ...form, userId: e.target.value }))} required>
                  <option value="">Selecione...</option>
                  {availableUsers.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}
                </select>
              </Field>
              <ReasonField value={memberForm.reason} onChange={(reason) => setMemberForm((form) => ({ ...form, reason }))} label="Motivo da inclusão" />
              <ApiError message={error} />
              <div className="flex justify-end"><button type="submit" className="btn-primary justify-center" disabled={saving || !memberForm.userId || memberForm.reason.trim().length < 10}>{saving ? 'Adicionando...' : 'Adicionar ao grupo'}</button></div>
            </form>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(removeTarget)} onClose={() => !saving && setRemoveTarget(null)} title="Remover membro do grupo" maxWidth="max-w-lg">
        {removeTarget ? (
          <form onSubmit={removeMember} className="space-y-4">
            <SafetyNote danger>O acesso de {removeTarget.name} será reavaliado imediatamente pelas demais regras da feature flag.</SafetyNote>
            <ReasonField value={removeReason} onChange={setRemoveReason} label="Motivo da remoção" />
            <ApiError message={error} />
            <ModalActions onCancel={() => setRemoveTarget(null)} saving={saving} danger submitLabel="Remover do grupo" disabled={removeReason.trim().length < 10} />
          </form>
        ) : null}
      </Modal>
    </section>
  );
}
