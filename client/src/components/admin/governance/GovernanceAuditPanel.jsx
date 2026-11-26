import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, FileClock, Search, ShieldCheck } from 'lucide-react';
import { formatDate } from './GovernanceUi';

const actionLabels = {
  create_release: 'Release criada',
  update_release: 'Release atualizada',
  update_release_status: 'Estágio da release alterado',
  create_feature_flag: 'Feature flag criada',
  update_feature_flag: 'Feature flag atualizada',
  activate_kill_switch: 'Kill switch acionado',
  deactivate_kill_switch: 'Kill switch desativado',
  create_pilot_group: 'Grupo-piloto criado',
  update_pilot_group: 'Grupo-piloto atualizado',
  add_pilot_group_member: 'Membro adicionado',
  remove_pilot_group_member: 'Membro removido',
  upsert_feature_flag_group_rule: 'Regra de grupo alterada',
  remove_feature_flag_group_rule: 'Regra de grupo removida',
  upsert_feature_flag_user_rule: 'Regra individual alterada',
  remove_feature_flag_user_rule: 'Regra individual removida',
};

const entityLabels = {
  release: 'Release',
  feature_flag: 'Feature flag',
  pilot_group: 'Grupo-piloto',
  pilot_group_member: 'Membro de piloto',
  feature_flag_rule: 'Regra de acesso',
};

export default function GovernanceAuditPanel({ audit }) {
  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('');
  const [expanded, setExpanded] = useState(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return audit.filter((entry) => {
      if (entity && entry.entity_type !== entity) return false;
      if (!term) return true;
      return [
        entry.actor_name,
        entry.actor_email,
        entry.action,
        entry.entity_key,
        entry.reason,
      ].some((value) => String(value || '').toLowerCase().includes(term));
    });
  }, [audit, entity, search]);

  return (
    <section aria-labelledby="audit-title">
      <div className="mb-4">
        <h2 id="audit-title" className="text-lg font-black text-neutral-900 dark:text-white">Auditoria de governança</h2>
        <p className="mt-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          Histórico imutável de alterações, motivos e estados anteriores.
        </p>
      </div>

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <label className="relative block">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input className="input !pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar administrador, motivo ou chave..." />
        </label>
        <select className="select" value={entity} onChange={(event) => setEntity(event.target.value)} aria-label="Filtrar tipo de registro">
          <option value="">Todos os tipos</option>
          {Object.entries(entityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>

      <div className="space-y-3">
        {filtered.map((entry) => {
          const open = expanded === entry.id;
          const critical = entry.action.includes('kill_switch') || entry.action.includes('release_status');
          return (
            <article key={entry.id} className={`card overflow-hidden ${critical ? '!border-amber-300 dark:!border-amber-500/30' : ''}`}>
              <button type="button" className="flex w-full items-start gap-3 p-4 text-left" onClick={() => setExpanded(open ? null : entry.id)} aria-expanded={open}>
                <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${critical ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200' : 'bg-primary-50 text-primary-600 dark:bg-cyan-400/10 dark:text-cyan-200'}`}>
                  {critical ? <ShieldCheck size={18} /> : <FileClock size={18} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-black text-neutral-900 dark:text-white">{actionLabels[entry.action] || entry.action}</h3>
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-black text-neutral-600 dark:bg-white/10 dark:text-neutral-300">{entityLabels[entry.entity_type] || entry.entity_type}</span>
                    {critical ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">Ação crítica</span> : null}
                  </div>
                  <p className="mt-1 text-xs font-semibold text-neutral-600 dark:text-neutral-300">{entry.reason}</p>
                  <p className="mt-2 text-[11px] font-medium text-neutral-400">
                    {entry.actor_name || entry.actor_email || 'Usuário removido'} · {formatDate(entry.created_at)}
                    {entry.entity_key ? ` · ${entry.entity_key}` : ''}
                  </p>
                </div>
                {open ? <ChevronUp size={17} className="mt-1 flex-shrink-0 text-neutral-400" /> : <ChevronDown size={17} className="mt-1 flex-shrink-0 text-neutral-400" />}
              </button>

              {open ? (
                <div className="grid gap-3 border-t border-neutral-100 bg-neutral-50/70 p-4 dark:border-white/10 dark:bg-white/[0.03] lg:grid-cols-2">
                  <AuditState title="Estado anterior" value={entry.previous} />
                  <AuditState title="Estado registrado" value={entry.current} />
                  <div className="lg:col-span-2 grid gap-2 text-[11px] font-medium text-neutral-500 dark:text-neutral-400 sm:grid-cols-2">
                    <p><span className="font-black">IP:</span> {entry.ip_address || 'Não registrado'}</p>
                    <p><span className="font-black">Navegador:</span> {entry.user_agent || 'Não registrado'}</p>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}

        {filtered.length === 0 ? (
          <div className="card border-dashed p-8 text-center">
            <FileClock size={28} className="mx-auto text-neutral-400" />
            <h3 className="mt-3 font-black text-neutral-800 dark:text-neutral-100">Nenhum registro encontrado</h3>
            <p className="mt-1 text-sm font-medium text-neutral-500 dark:text-neutral-400">Ajuste os filtros ou realize a primeira alteração de governança.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AuditState({ title, value }) {
  return (
    <div className="min-w-0 rounded-xl border border-neutral-200 bg-white p-3 dark:border-white/10 dark:bg-neutral-900/40">
      <p className="mb-2 text-[10px] font-black uppercase tracking-wide text-neutral-400">{title}</p>
      {value ? (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] font-medium leading-relaxed text-neutral-600 dark:text-neutral-300">{JSON.stringify(value, null, 2)}</pre>
      ) : (
        <p className="text-xs font-medium text-neutral-400">Não aplicável.</p>
      )}
    </div>
  );
}
