import { useEffect, useState } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  CheckCircle2,
  ClipboardCheck,
  GraduationCap,
  KeyRound,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  School,
  ShieldCheck,
  UserPlus,
  UsersRound,
} from 'lucide-react';

import AccessibleCombobox from './form/AccessibleCombobox';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import useInstitutionalManagement from '../hooks/useInstitutionalManagement';
import InstitutionalWriteReview from './InstitutionalWriteReview';

const roleOptions = [
  { value: 'teacher', label: 'Professor(a)' },
  { value: 'school_coordinator', label: 'Coordenação escolar' },
  { value: 'school_manager', label: 'Gestão escolar' },
  { value: 'municipal_manager', label: 'Gestão municipal' },
];

function errorMessage(error) {
  return (typeof error?.response?.data?.error === 'string' ? error.response.data.error : '') || 'Não foi possível concluir a operação. Tente novamente.';
}

function dependencyLabel(value) {
  return ({
    federal: 'Federal',
    state: 'Estadual',
    municipal: 'Municipal',
    private: 'Privada',
  })[value] || 'Dependência não informada';
}

function statusLabel(value) {
  return ({ active: 'Ativa', paused: 'Paralisada', closed: 'Extinta' })[value] || 'Situação não informada';
}

function schoolDirectoryEmptyMessage(query, directoryInfo) {
  if (query.trim().length < 2) return 'Digite ao menos duas letras para consultar o catálogo.';
  if (directoryInfo?.reason === 'directory_not_imported') {
    return 'O catálogo oficial ainda não foi importado nesta homologação. Use a inclusão manual.';
  }
  return 'Nenhuma escola ativa encontrada para esta busca. A inclusão manual continua disponível.';
}

export default function InstitutionalManagementPanel(props) {
  const { user, announcementAccessId } = useAuth();
  return user ? <ManagementPanel key={`${user.id}:${user.role}:${announcementAccessId}`} {...props} user={user} /> : null;
}

function ManagementPanel({ user, onChanged, onReady, compact = false }) {
  const flow = useInstitutionalManagement(user, onChanged);
  const { state, reading, readError, notice, busyAction, load, mutate } = flow;
  const ready = Boolean(state);
  useEffect(() => { if (ready) onReady?.(); }, [ready, onReady]);
  if (!state) return <section data-institutional-forms className="py-2 text-sm" role={readError ? 'alert' : 'status'}>
    <p>{readError || 'Consultando cadastros e confirmações…'}</p>
    {readError && <button type="button" className="btn-secondary mt-2 min-h-11" onClick={load} disabled={reading}>Tentar novamente</button>}
  </section>;
  return <section data-institutional-forms className="space-y-3" aria-label={compact ? 'Confirmações de turmas' : 'Cadastros institucionais'}>
    {notice && <p role="status" className="rounded-xl border border-cyan-300 bg-cyan-50 p-3 text-sm text-cyan-950 dark:bg-cyan-400/10 dark:text-cyan-100">{notice}</p>}
    {readError && <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-100"><p>{readError} Atualize os cadastros antes de outro envio. Uma gravação já confirmada continua salva.</p><button type="button" className="btn-secondary mt-2 min-h-11" onClick={load} disabled={reading}>Tentar novamente</button></div>}
    {reading && <p role="status" className="text-sm">Atualizando cadastros…</p>}
    <fieldset className="min-w-0" disabled={Boolean(busyAction)}>
      {state.mode === 'admin' ? <AdminPilot state={state} mutate={mutate} busyAction={busyAction} refresh={load} /> : <ProfessionalPilot state={state} mutate={mutate} busyAction={busyAction} compact={compact} failed={Boolean(readError)} />}
    </fieldset>
    <InstitutionalWriteReview {...flow} />
  </section>;
}

function AdminPilot({ state, mutate, busyAction, refresh }) {
  const [task, setTask] = useState('municipality');
  return <div className="space-y-3">
    <div><div className="flex items-center justify-between gap-2"><label htmlFor="institutional-task" className="text-sm font-bold">O que você precisa fazer?</label><button type="button" aria-label="Atualizar cadastros" className="min-h-11 shrink-0 px-2 text-sm font-semibold text-cyan-800 dark:text-cyan-200" onClick={refresh} disabled={Boolean(busyAction)}>Atualizar</button></div><select id="institutional-task" className={inputClass} value={task} onChange={event => setTask(event.target.value)}>
      <option value="municipality">1. Cadastrar município</option><option value="school">2. Adicionar escola</option><option value="professional">3. Vincular profissional</option><option value="class">4. Preparar turma</option><option value="classes">Consultar turmas enviadas</option>
    </select></div>
    <div hidden={task !== 'municipality'}><MunicipalityForm state={state} mutate={mutate} busyAction={busyAction} active={task === 'municipality'} /></div>
    <div hidden={task !== 'school'}>{!state.municipalities.some(item => item.status === 'active') && <p className="mb-3 text-sm">Comece cadastrando um município na tarefa 1.</p>}<SchoolForm state={state} mutate={mutate} busyAction={busyAction} active={task === 'school'} /></div>
    <div hidden={task !== 'professional'}><MembershipWorkspace state={state} mutate={mutate} busyAction={busyAction} /></div>
    <div hidden={task !== 'class'}>{!state.teacherMemberships.length && <p className="mb-3 text-sm">Vincule primeiro um professor à escola na tarefa 3.</p>}<GuidedClassForm state={state} mutate={mutate} busyAction={busyAction} /></div>
    <div hidden={task !== 'classes'}><OperationalSnapshot state={state} /></div>
  </div>;
}

function FormShell({ title, description, children }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31] sm:p-4"><h3 className="text-base font-bold text-slate-900 dark:text-white">{title}</h3><p className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-300">{description}</p><div className="mt-3">{children}</div></section>;
}

function Field({ label, hint, htmlFor, children }) {
  return <div className="block text-sm font-bold text-neutral-700 dark:text-neutral-200"><label htmlFor={htmlFor}>{label}</label>{children}{hint && <span className="mt-1 block text-xs font-normal leading-5 text-slate-600 dark:text-slate-300">{hint}</span>}</div>;
}

const inputClass = 'mt-1 min-h-11 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-white/10 dark:bg-white/[0.04] dark:text-white';

function SubmitButton({ busy, disabled, children }) {
  return <button type="submit" className="btn-primary min-h-11 w-full justify-center" disabled={busy || disabled}>{busy ? <Loader2 className="animate-spin" size={17} /> : <Plus size={17} />}{children}</button>;
}

function MunicipalityForm({ state, mutate, busyAction, active }) {
  const [mode, setMode] = useState('official');
  const [form, setForm] = useState({ name: '', ibgeCode: '' });
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState('');

  useEffect(() => {
    if (!active || mode !== 'official' || query.trim().length < 2) {
      setDirectoryLoading(false);
      setDirectoryError('');
      if (query.trim().length < 2) setOptions([]);
      return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setDirectoryLoading(true);
      setDirectoryError('');
      try {
        const response = await api.get('/institutions/management/directories/municipalities', {
          params: { query: query.trim() }, timeout: 15000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setOptions(response.data.results.map((item) => {
          const registered = state.municipalities.find((municipality) => (
            municipality.status === 'active' && municipality.ibgeCode === item.ibgeCode
          ));
          return {
            value: item.ibgeCode,
            label: `${item.name} · ${item.uf}`,
            description: registered ? `Código IBGE ${item.ibgeCode} · Já cadastrado` : `Código IBGE ${item.ibgeCode}`,
            disabled: Boolean(registered),
            directoryItem: item,
          };
        }));
      } catch (requestError) {
        if (requestError.code !== 'ERR_CANCELED') {
          setOptions([]);
          setDirectoryError(errorMessage(requestError));
        }
      } finally {
        if (!controller.signal.aborted) setDirectoryLoading(false);
      }
    }, 280);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [active, mode, query, state.municipalities]);

  const reset = (nextMode = mode) => {
    setMode(nextMode);
    setForm({ name: '', ibgeCode: '' });
    setSelected(null);
    setQuery('');
    setOptions([]);
    setDirectoryError('');
  };
  const submit = async (event) => {
    event.preventDefault();
    const ok = await mutate({
      action: 'municipality',
      url: '/institutions/management/municipalities',
      data: form,
      success: 'Município cadastrado e registrado na auditoria.',
    });
    if (ok) reset();
  };
  return (
    <FormShell icon={Building2} step="1" title="Cadastrar município" description="Localize o município na base oficial do IBGE; nome, UF e código são preenchidos juntos.">
      <form className="space-y-4" onSubmit={submit}>
        <div className="flex rounded-xl bg-neutral-100 p-1 dark:bg-white/[0.05]" role="group" aria-label="Origem do município">
          <button type="button" aria-pressed={mode === 'official'} className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-black ${mode === 'official' ? 'bg-white text-cyan-700 shadow-sm dark:bg-white/10 dark:text-cyan-200' : 'text-neutral-500'}`} onClick={() => { if (mode !== 'official' && ((!form.name && !form.ibgeCode) || window.confirm('Trocar a origem e limpar o município preenchido?'))) reset('official'); }}>Buscar no IBGE</button>
          <button type="button" aria-pressed={mode === 'manual'} className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-black ${mode === 'manual' ? 'bg-white text-cyan-700 shadow-sm dark:bg-white/10 dark:text-cyan-200' : 'text-neutral-500'}`} onClick={() => { if (mode !== 'manual' && ((!form.name && !form.ibgeCode) || window.confirm('Trocar a origem e limpar o município preenchido?'))) reset('manual'); }}>Incluir manualmente</button>
        </div>
        {mode === 'official' ? (
          <>
            <Field htmlFor="municipality-directory" label="Município" hint="Digite ao menos duas letras. A UF diferencia municípios com nomes semelhantes.">
              <AccessibleCombobox
                id="municipality-directory"
                value={selected?.ibgeCode || ''}
                options={options}
                onChange={(_value, option) => {
                  const item = option.directoryItem;
                  setSelected(item);
                  setForm({ name: item.name, ibgeCode: item.ibgeCode });
                }}
                onQueryChange={(nextQuery) => {
                  setQuery(nextQuery); setOptions([]);
                  setSelected(null);
                  setForm({ name: '', ibgeCode: '' });
                }}
                placeholder="Digite o nome do município"
                searchPlaceholder="Ex.: Belo Horizonte"
                emptyMessage={query.trim().length < 2 ? 'Digite ao menos duas letras para consultar o IBGE.' : 'Nenhum município encontrado.'}
                loading={directoryLoading}
                remote
                required
              />
            </Field>
            {directoryError && <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold leading-5 text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-200">{directoryError} O cadastro manual continua disponível.</p>}
            {selected && (
              <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/[0.07] dark:text-emerald-100">
                <BadgeCheck className="mt-0.5 shrink-0" size={17} />
                <p className="text-xs leading-5"><strong>{selected.name} · {selected.uf}</strong><br />Código IBGE {selected.ibgeCode} preenchido pela base oficial.</p>
              </div>
            )}
          </>
        ) : (
          <>
            <Field htmlFor="municipality-name-manual" label="Nome do município"><input id="municipality-name-manual" className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={160} required /></Field>
            <Field htmlFor="municipality-code-manual" label="Código IBGE" hint="Opcional no modo manual; quando informado, use sete números."><input id="municipality-code-manual" className={inputClass} value={form.ibgeCode} onChange={(event) => setForm({ ...form, ibgeCode: event.target.value.replace(/\D/g, '').slice(0, 7) })} inputMode="numeric" pattern="[0-9]{7}" /></Field>
          </>
        )}
        <SubmitButton busy={busyAction === 'municipality'} disabled={Boolean(busyAction) || form.name.trim().length < 2}>Salvar município</SubmitButton>
      </form>
    </FormShell>
  );
}

function SchoolForm({ state, mutate, busyAction, active }) {
  const activeMunicipalities = state.municipalities.filter((item) => item.status === 'active');
  const [form, setForm] = useState({ municipalityPublicId: '', name: '', censusCode: '' });
  const [mode, setMode] = useState('official');
  const [query, setQuery] = useState('');
  const [directoryOptions, setDirectoryOptions] = useState([]);
  const [selectedDirectorySchool, setSelectedDirectorySchool] = useState(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryInfo, setDirectoryInfo] = useState(null);
  const municipalityOptions = activeMunicipalities.map((item) => ({
    value: item.publicId,
    label: item.name,
    description: item.ibgeCode ? `Código IBGE ${item.ibgeCode}` : 'Cadastro manual sem código IBGE',
  }));
  const selectedMunicipality = activeMunicipalities.find((item) => item.publicId === form.municipalityPublicId);
  useEffect(() => {
    if (!active || mode !== 'official' || !form.municipalityPublicId || query.trim().length < 2 || !selectedMunicipality?.ibgeCode) {
      setDirectoryLoading(false);
      setDirectoryError('');
      if (query.trim().length < 2) setDirectoryOptions([]);
      return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setDirectoryLoading(true);
      setDirectoryError('');
      try {
        const response = await api.get('/institutions/management/directories/schools', {
          params: { municipalityPublicId: form.municipalityPublicId, query: query.trim() }, timeout: 15000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDirectoryInfo(response.data);
        setDirectoryOptions(response.data.results.map((item) => ({
          value: item.censusCode,
          label: item.name,
          description: `${item.censusCode} · ${dependencyLabel(item.administrativeDependency)}${item.alreadyRegistered ? ' · Já cadastrada' : item.operatingStatus !== 'active' ? ` · ${statusLabel(item.operatingStatus)}` : ''}`,
          disabled: item.alreadyRegistered || item.operatingStatus !== 'active',
          directoryItem: item,
        })));
      } catch (requestError) {
        if (requestError.code !== 'ERR_CANCELED') {
          setDirectoryOptions([]);
          setDirectoryError(errorMessage(requestError));
        }
      } finally {
        if (!controller.signal.aborted) setDirectoryLoading(false);
      }
    }, 280);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [active, form.municipalityPublicId, mode, query, selectedMunicipality?.ibgeCode]);

  const resetSchool = (nextMode = mode) => {
    setMode(nextMode);
    setQuery('');
    setDirectoryOptions([]);
    setSelectedDirectorySchool(null);
    setDirectoryError('');
    setDirectoryInfo(null);
    setForm((current) => ({ ...current, name: '', censusCode: '' }));
  };
  const submit = async (event) => {
    event.preventDefault();
    const ok = await mutate({
      action: 'school',
      url: `/institutions/management/municipalities/${form.municipalityPublicId}/schools`,
      data: { name: form.name, censusCode: form.censusCode },
      success: 'Escola cadastrada dentro do município selecionado.',
    });
    if (ok) resetSchool();
  };
  return (
    <FormShell icon={School} step="2" title="Adicionar escola" description="Selecione o município e consulte o catálogo oficial; a inclusão manual continua disponível.">
      <form className="space-y-4" onSubmit={submit}>
        <Field htmlFor="school-municipality" label="Município">
          <AccessibleCombobox id="school-municipality" value={form.municipalityPublicId} options={municipalityOptions} onChange={(value) => { if (value === form.municipalityPublicId) return; if ((form.name || form.censusCode) && !window.confirm('Trocar o município e limpar a escola preenchida?')) return; setForm({ municipalityPublicId: value, name: '', censusCode: '' }); resetSchool(mode); }} placeholder="Selecione o município" emptyMessage="Cadastre primeiro um município." required />
        </Field>
        <div className="flex rounded-xl bg-neutral-100 p-1 dark:bg-white/[0.05]" role="group" aria-label="Origem da escola">
          <button type="button" aria-pressed={mode === 'official'} className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-black ${mode === 'official' ? 'bg-white text-cyan-700 shadow-sm dark:bg-white/10 dark:text-cyan-200' : 'text-neutral-500'}`} onClick={() => { if (mode !== 'official' && ((!form.name && !form.censusCode) || window.confirm('Trocar a origem e limpar a escola preenchida?'))) resetSchool('official'); }}>Rede municipal · Inep</button>
          <button type="button" aria-pressed={mode === 'manual'} className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-black ${mode === 'manual' ? 'bg-white text-cyan-700 shadow-sm dark:bg-white/10 dark:text-cyan-200' : 'text-neutral-500'}`} onClick={() => { if (mode !== 'manual' && ((!form.name && !form.censusCode) || window.confirm('Trocar a origem e limpar a escola preenchida?'))) resetSchool('manual'); }}>Incluir manualmente</button>
        </div>
        {mode === 'official' ? (
          <>
            {!selectedMunicipality?.ibgeCode ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold leading-5 text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-200">Escolha um município com código IBGE para consultar o catálogo. Sem código, use a inclusão manual.</p>
            ) : (
              <Field htmlFor="school-directory" label="Escola" hint="Digite parte do nome ou o Código Inep. Escolas já cadastradas são identificadas.">
                <AccessibleCombobox
                  id="school-directory"
                  value={selectedDirectorySchool?.censusCode || ''}
                  options={directoryOptions}
                  onChange={(_value, option) => {
                    const item = option.directoryItem;
                    setSelectedDirectorySchool(item);
                    setForm((current) => ({ ...current, name: item.name, censusCode: item.censusCode }));
                  }}
                  onQueryChange={(nextQuery) => {
                    setQuery(nextQuery); setDirectoryOptions([]); setDirectoryInfo(null);
                    setSelectedDirectorySchool(null);
                    setForm((current) => ({ ...current, name: '', censusCode: '' }));
                  }}
                  placeholder="Digite o nome da escola"
                  searchPlaceholder="Ex.: Escola Municipal"
                  emptyMessage={schoolDirectoryEmptyMessage(query, directoryInfo)}
                  loading={directoryLoading}
                  remote
                  required
                />
              </Field>
            )}
            {directoryError && <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold leading-5 text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-200">{directoryError} A inclusão manual continua disponível.</p>}
            {directoryInfo?.source && <p className="flex items-center gap-2 text-[11px] font-bold text-neutral-500 dark:text-neutral-300"><BadgeCheck className="text-emerald-500" size={15} /> {directoryInfo.source.name} · Rede municipal · Censo {directoryInfo.source.censusYear}</p>}
            {selectedDirectorySchool && <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/[0.07] dark:text-emerald-100">Código Inep {selectedDirectorySchool.censusCode} preenchido pelo catálogo oficial.</p>}
          </>
        ) : (
          <>
            <Field htmlFor="school-name-manual" label="Nome da escola"><input id="school-name-manual" className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={180} required /></Field>
            <Field htmlFor="school-code-manual" label="Código Censo Escolar" hint="Opcional quando a escola ainda não aparece no catálogo."><input id="school-code-manual" className={inputClass} value={form.censusCode} onChange={(event) => setForm({ ...form, censusCode: event.target.value })} maxLength={32} /></Field>
          </>
        )}
        <SubmitButton busy={busyAction === 'school'} disabled={Boolean(busyAction) || !form.municipalityPublicId || form.name.trim().length < 2}>Salvar escola</SubmitButton>
      </form>
    </FormShell>
  );
}

function ScopeFields({ state, form, setForm, idPrefix }) {
  const activeMunicipalities = state.municipalities.filter((item) => item.status === 'active');
  const schools = state.schools.filter((item) => item.status === 'active' && item.municipalityPublicId === form.municipalityPublicId);
  const municipalityOptions = activeMunicipalities.map((item) => ({ value: item.publicId, label: item.name, description: item.ibgeCode ? `IBGE ${item.ibgeCode}` : undefined }));
  const schoolOptions = schools.map((item) => ({ value: item.publicId, label: item.name, description: item.censusCode ? `Inep ${item.censusCode}` : undefined }));
  const needsSchool = form.role !== 'municipal_manager';
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field htmlFor={`${idPrefix}-role`} label="Função na rede"><AccessibleCombobox id={`${idPrefix}-role`} value={form.role} options={roleOptions} onChange={(value) => setForm((current) => ({ ...current, role: value, schoolPublicId: '' }))} searchable={false} required /></Field>
      <Field htmlFor={`${idPrefix}-municipality`} label="Município"><AccessibleCombobox id={`${idPrefix}-municipality`} value={form.municipalityPublicId} options={municipalityOptions} onChange={(value) => setForm((current) => ({ ...current, municipalityPublicId: value, schoolPublicId: '' }))} placeholder="Selecione" emptyMessage="Cadastre primeiro um município." required /></Field>
      {needsSchool && <Field htmlFor={`${idPrefix}-school`} label="Escola"><AccessibleCombobox id={`${idPrefix}-school`} value={form.schoolPublicId} options={schoolOptions} onChange={(value) => setForm((current) => ({ ...current, schoolPublicId: value }))} placeholder="Selecione" emptyMessage="Cadastre primeiro uma escola neste município." required /></Field>}
    </div>
  );
}

function MembershipWorkspace({ state, mutate, busyAction }) {
  const [mode, setMode] = useState('existing');
  return (
    <FormShell icon={UserPlus} step="3" title="Cadastrar ou vincular profissional" description="Escolha uma conta e sua função na rede. Se necessário, crie uma conta para os testes.">
      <div className="mb-4 flex rounded-xl bg-neutral-100 p-1 dark:bg-white/[0.05]" role="group" aria-label="Modo de cadastro profissional">
        <button type="button" aria-pressed={mode === 'existing'} className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-black ${mode === 'existing' ? 'bg-white text-cyan-700 shadow-sm dark:bg-white/10 dark:text-cyan-200' : 'text-neutral-500'}`} onClick={() => setMode('existing')}>Conta existente</button>
        <button type="button" aria-pressed={mode === 'new'} className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-xs font-black ${mode === 'new' ? 'bg-white text-cyan-700 shadow-sm dark:bg-white/10 dark:text-cyan-200' : 'text-neutral-500'}`} onClick={() => setMode('new')}>Criar conta</button>
      </div>
      <div hidden={mode !== 'existing'}><ExistingMembershipForm state={state} mutate={mutate} busyAction={busyAction} /></div>
      <div hidden={mode !== 'new'}><NewProfessionalForm state={state} mutate={mutate} busyAction={busyAction} /></div>
    </FormShell>
  );
}

function ExistingMembershipForm({ state, mutate, busyAction }) {
  const [form, setForm] = useState({ userId: '', role: 'teacher', municipalityPublicId: '', schoolPublicId: '' });
  const professionalOptions = state.professionals.map((item) => ({ value: item.id, label: item.name, description: item.email }));
  const submit = async (event) => {
    event.preventDefault();
    const ok = await mutate({
      action: 'membership',
      url: '/institutions/management/memberships',
      data: { ...form, userId: Number(form.userId), schoolPublicId: form.role === 'municipal_manager' ? null : form.schoolPublicId },
      success: 'Profissional vinculado à rede selecionada.',
    });
    if (ok) setForm((current) => ({ ...current, userId: '' }));
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <Field htmlFor="existing-professional" label="Profissional"><AccessibleCombobox id="existing-professional" value={form.userId} options={professionalOptions} onChange={(value) => setForm({ ...form, userId: value })} placeholder="Selecione uma conta" emptyMessage="Nenhuma conta profissional disponível." required /></Field>
      <ScopeFields state={state} form={form} setForm={setForm} idPrefix="existing-scope" />
      <SubmitButton busy={busyAction === 'membership'} disabled={Boolean(busyAction) || !state.municipalities.length || !state.professionals.length || !form.userId || !form.municipalityPublicId || (form.role !== 'municipal_manager' && !form.schoolPublicId)}>Confirmar vínculo</SubmitButton>
    </form>
  );
}

function NewProfessionalForm({ state, mutate, busyAction }) {
  const [form, setForm] = useState({ name: '', email: '', temporaryPassword: '', role: 'teacher', municipalityPublicId: '', schoolPublicId: '' });
  const submit = async (event) => {
    event.preventDefault();
    const ok = await mutate({
      action: 'professional',
      url: '/institutions/management/professionals',
      data: { ...form, schoolPublicId: form.role === 'municipal_manager' ? null : form.schoolPublicId },
      success: 'Conta piloto criada e vinculada com sucesso.',
    });
    setForm((current) => ({ ...current, ...(ok ? { name: '', email: '' } : {}), temporaryPassword: '' }));
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor="new-professional-name" label="Nome"><input id="new-professional-name" className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={100} required /></Field>
        <Field htmlFor="new-professional-email" label="E-mail"><input id="new-professional-email" className={inputClass} type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} maxLength={254} required /></Field>
      </div>
      <Field htmlFor="new-professional-password" label="Senha temporária" hint="Mínimo de 10 caracteres. A senha é limpa ao terminar ou cancelar a conferência."><input id="new-professional-password" className={inputClass} type="password" value={form.temporaryPassword} onChange={(event) => setForm({ ...form, temporaryPassword: event.target.value })} minLength={10} maxLength={200} autoComplete="new-password" required /></Field>
      <ScopeFields state={state} form={form} setForm={setForm} idPrefix="new-scope" />
      <SubmitButton busy={busyAction === 'professional'} disabled={Boolean(busyAction) || !form.municipalityPublicId || (form.role !== 'municipal_manager' && !form.schoolPublicId)}>Criar e vincular</SubmitButton>
    </form>
  );
}

function GuidedClassForm({ state, mutate, busyAction }) {
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState({ membershipPublicId: '', name: '', gradeId: '', academicYear: currentYear, disciplineIds: [] });
  const toggleDiscipline = (id) => setForm((current) => ({
    ...current,
    disciplineIds: current.disciplineIds.includes(id)
      ? current.disciplineIds.filter((item) => item !== id)
      : [...current.disciplineIds, id],
  }));
  const membershipOptions = state.teacherMemberships.map((item) => ({
    value: item.publicId,
    label: item.professionalName,
    description: `${item.schoolName} · ${item.municipalityName}`,
  }));
  const gradeOptions = state.grades.map((item) => ({ value: item.id, label: item.name }));
  const submit = async (event) => {
    event.preventDefault();
    const ok = await mutate({
      action: 'class',
      url: '/institutions/management/classes',
      data: { ...form, gradeId: Number(form.gradeId), academicYear: Number(form.academicYear) },
      success: 'Turma preparada. O professor responsável já pode confirmá-la em seu acesso.',
    });
    if (ok) setForm((current) => ({ ...current, name: '' }));
  };
  return (
    <FormShell icon={GraduationCap} step="4" title="Preparar turma para o professor" description="Escolha professor, escola e ano escolar. Depois de salvar, o professor confere a turma na própria conta.">
      <form className="space-y-4" onSubmit={submit}>
        <Field htmlFor="guided-class-membership" label="Professor e escola"><AccessibleCombobox id="guided-class-membership" value={form.membershipPublicId} options={membershipOptions} onChange={(value) => setForm({ ...form, membershipPublicId: value })} placeholder="Selecione" emptyMessage="Vincule primeiro um professor a uma escola." required /></Field>
        <Field htmlFor="guided-class-name" label="Nome da turma"><input id="guided-class-name" className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={120} placeholder="Ex.: 7º A · Matutino" required /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor="guided-class-grade" label="Ano escolar"><AccessibleCombobox id="guided-class-grade" value={form.gradeId} options={gradeOptions} onChange={(value) => setForm({ ...form, gradeId: value })} searchable={false} required /></Field>
          <Field htmlFor="guided-class-year" label="Ano letivo"><input id="guided-class-year" className={inputClass} type="number" min="2000" max={currentYear + 5} value={form.academicYear} onChange={(event) => setForm({ ...form, academicYear: event.target.value })} required /></Field>
        </div>
        <fieldset><legend className="text-sm font-bold text-neutral-700 dark:text-neutral-200">Componentes curriculares</legend><div className="mt-2 flex flex-wrap gap-2">{state.disciplines.map((item) => <label key={item.id} className={`inline-flex min-h-11 cursor-pointer items-center rounded-xl border px-3 py-2 text-sm font-bold ${form.disciplineIds.includes(item.id) ? 'border-cyan-400 bg-cyan-50 text-cyan-800 dark:bg-cyan-400/10 dark:text-cyan-200' : 'border-neutral-200 text-neutral-500 dark:border-white/10'}`}><input className="mr-2 h-4 w-4 shrink-0 accent-cyan-700" type="checkbox" checked={form.disciplineIds.includes(item.id)} onChange={() => toggleDiscipline(item.id)} />{item.name}</label>)}</div></fieldset>
        <SubmitButton busy={busyAction === 'class'} disabled={Boolean(busyAction) || !form.membershipPublicId || !form.gradeId || !form.disciplineIds.length}>Preparar e enviar</SubmitButton>
      </form>
    </FormShell>
  );
}

function OperationalSnapshot({ state }) {
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all'), [limit, setLimit] = useState(10);
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const filtered = state.guidedClasses.filter(item => (status === 'all' || item.migrationStatus === status) && normalize([item.name, item.teacher.name, item.schoolName, item.municipalityName].join(' ')).includes(normalize(query.trim())));
  return <FormShell title="Turmas enviadas" description="Confira as turmas preparadas pela administração e a confirmação dos professores.">
    <div className="grid gap-3 sm:grid-cols-2">
      <Field htmlFor="guided-search" label="Buscar turma, professor ou escola"><input id="guided-search" type="search" className={inputClass} value={query} onChange={event => { setQuery(event.target.value); setLimit(10); }} /></Field>
      <Field htmlFor="guided-status" label="Confirmação"><select id="guided-status" className={inputClass} value={status} onChange={event => { setStatus(event.target.value); setLimit(10); }}><option value="all">Todas</option><option value="linked">Aguardando professor</option><option value="verified">Confirmadas</option></select></Field>
    </div>
    <p className="my-3 text-sm text-slate-600 dark:text-slate-300">{Math.min(limit, filtered.length)} de {filtered.length} turma(s) nesta consulta. A consulta reúne até as 100 turmas mais recentes.</p>
    <div className="divide-y divide-slate-200 dark:divide-white/10">{filtered.slice(0, limit).map(item => <article key={item.publicId} className="py-3">
      <h4 className="font-bold text-slate-900 dark:text-white">{item.name}</h4>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.teacher.name} · {item.schoolName} · {item.municipalityName}</p>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.grade.name} · {item.academicYear}</p>
      <p className="mt-1 text-sm font-bold text-cyan-800 dark:text-cyan-200">{item.migrationStatus === 'verified' ? 'Confirmada pelo professor' : 'Aguardando o professor confirmar'}</p>
    </article>)}</div>
    {!filtered.length && <p className="py-3 text-sm">{state.guidedClasses.length ? 'Nenhuma turma nesta busca. Confira o nome ou a confirmação escolhida.' : 'Nenhuma turma preparada ainda. Use a tarefa 4 para preparar uma turma.'}</p>}
    {limit < filtered.length && <button className="btn-secondary mt-3 min-h-11" onClick={() => setLimit(value => value + 10)} type="button">Mostrar mais turmas</button>}
  </FormShell>;
}

function ProfessionalPilot({ state, mutate, busyAction, compact, failed }) {
  const pending = state.pendingConfirmations || [];
  if (compact && pending.length === 0) return failed ? null : <p className="flex items-center gap-2 px-1 py-1 text-sm text-neutral-700 dark:text-slate-200"><CheckCircle2 className="shrink-0 text-emerald-600 dark:text-emerald-300" size={18} />Nenhuma turma aguardando sua confirmação.</p>;
  return (
    <section className={compact ? 'card p-4' : 'card p-5 sm:p-6'}>
      <div className="flex items-start gap-3"><ClipboardCheck className="mt-1 shrink-0 text-amber-700 dark:text-amber-300" size={20} /><div><h2 className="text-base font-bold text-[#102A56] dark:text-white">Turmas para você confirmar</h2><p className="mt-1 text-sm leading-5 text-neutral-600 dark:text-slate-300">Confira a escola, o município, o ano escolar e a turma antes de confirmar.</p></div></div>
      <div className="mt-3 space-y-3">
        {pending.length ? pending.map((item) => (
          <article key={item.publicId} className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-400/20 dark:bg-amber-400/[0.06]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 break-words"><h3 className="font-bold text-neutral-900 dark:text-white">{item.name}</h3><p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{item.schoolName} · {item.municipalityName}</p><p className="mt-1 text-sm text-neutral-600 dark:text-slate-300">{item.grade.name} · {item.academicYear}</p></div>
              <button
                type="button"
                className="btn-primary min-h-11 shrink-0 justify-center"
                disabled={Boolean(busyAction)}
                onClick={() => mutate({
                  action: `confirm-${item.publicId}`,
                  url: `/institutions/management/classes/${item.publicId}/confirm`,
                  data: { expectedContextUpdatedAt: item.contextUpdatedAt },
                  success: 'Turma confirmada. O vínculo com a escola foi atualizado.',
                })}
              >
                {busyAction === `confirm-${item.publicId}` ? <Loader2 className="animate-spin" size={17} /> : <CheckCircle2 size={17} />} Confirmar turma
              </button>
            </div>
          </article>
        )) : (
          <div className="rounded-2xl border border-dashed border-neutral-300 px-5 py-10 text-center dark:border-white/15"><CheckCircle2 className="mx-auto text-emerald-500" size={30} /><p className="mt-3 font-black text-neutral-800 dark:text-neutral-100">Nenhuma confirmação pendente</p><p className="mt-1 text-sm text-neutral-400">Quando a administração preparar uma turma para você, ela aparecerá aqui.</p></div>
        )}
      </div>
      {compact ? <p className="mt-3 text-sm leading-5 text-neutral-600 dark:text-slate-300">Algo está diferente? Não confirme ainda. Peça à administração para conferir os dados.</p> : <div className="mt-5 flex items-start gap-3 rounded-2xl bg-cyan-50 p-4 text-cyan-900 dark:bg-cyan-400/[0.07] dark:text-cyan-100"><ArrowRight className="mt-0.5 shrink-0" size={18} /><p className="text-xs leading-5">Depois da confirmação, use a área <strong>Turmas</strong> para estudantes, atividades e avaliações. O vínculo institucional apenas organiza o contexto da rede.</p></div>}
    </section>
  );
}
