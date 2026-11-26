import { createPortal } from 'react-dom';
import useModalLifecycle from '../hooks/useModalLifecycle';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, ArrowLeft, Check, ChevronRight, CircleAlert, ClipboardCopy, FileSpreadsheet, KeyRound, Pencil, Plus, RefreshCw, RotateCcw, Search, UserMinus, UserPlus, X } from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import MaterialResourceState, { materialButton, materialFocus, materialSurface } from '../components/MaterialResourceState';
import ClassAssessments from '../components/ClassAssessments';
import { classNavigation, classSelectionChange, classSearchChange, classesQuery, classesRequest, parseClasses, parseClassesBootstrap, parseClassDetail, studentMatches } from '../services/classesView.mjs';

const currentYear = new Date().getFullYear();
const emptyClassForm = { name: '', gradeId: '', academicYear: String(currentYear), disciplineIds: [] };
const button = `${materialButton} min-w-11`;
const primary = `${button} bg-blue-600 !text-white hover:!bg-blue-700`;

function Modal({ title, description, onClose, closeDisabled = false, children, width = 'max-w-xl' }) {
  const dialogRef = useRef(null);
  useModalLifecycle(dialogRef, { onClose, closeDisabled });
  return createPortal(<div data-modal-layer className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm">
    <div data-class-dialog ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label={title} className={`max-h-[calc(100dvh-2rem)] w-full overflow-y-auto overscroll-contain rounded-2xl border border-neutral-200 bg-white shadow-2xl outline-none dark:border-white/10 dark:bg-[#111E31] ${width}`}>
      <div className="flex items-start justify-between gap-2 border-b border-neutral-100 px-4 py-3 dark:border-white/10">
        <div><h2 className="text-lg font-bold text-neutral-900 dark:text-white">{title}</h2>
          {description && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{description}</p>}</div>
        <button type="button" disabled={closeDisabled} onClick={onClose} className={button} aria-label="Fechar"><X size={19} aria-hidden="true" /></button>
      </div>{children}
    </div>
  </div>, document.body);
}
function FieldLabel({ children, htmlFor }) {
  return <label htmlFor={htmlFor} className="mb-1 block text-sm font-semibold text-slate-700 dark:text-slate-200">{children}</label>;
}
export default function Classes() {
  const { user, announcementAccessId } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  return <ClassesWorkspace key={identity} identity={identity} />;
}
function ClassesWorkspace({ identity }) {
  const { isEnabled } = useFeatureFlags();
  const [params, setParams] = useSearchParams();
  const query = classesQuery(params);
  const [search, setSearch] = useState(query.search);
  const searchChanged = useRef(false);
  const listHeading = useRef(null);
  const detailHeading = useRef(null);
  const navigateFocus = useRef(null);
  const [modal, setModal] = useState(null);
  const bootstrap = useReadOnlyResource('/classes/bootstrap', identity, parseClassesBootstrap);
  const list = useReadOnlyResource(classesRequest(query.status, query.search), identity, parseClasses);
  const detail = useReadOnlyResource(query.id ? `/classes/${encodeURIComponent(query.id)}` : null, identity, parseClassDetail);
  const selected = detail.data;
  const busySearch = search.trim() !== query.search.trim();
  const change = changes => setParams(classNavigation(params, changes));
  const setStatus = status => { searchChanged.current = false; setSearch(''); change({ situacao: status === 'active' ? null : status, busca: null, turma: null, secao: null, simulado: null }); };
  const clearSearch = () => { searchChanged.current = false; setSearch(''); change({ busca: null }); };
  useEffect(() => { searchChanged.current = false; setSearch(query.search); }, [query.search]);
  useEffect(() => {
    if (!searchChanged.current) return undefined;
    const timer = setTimeout(() => { searchChanged.current = false; change(classSearchChange(query, search)); }, 250);
    return () => clearTimeout(timer);
  }, [search, params]);
  function openClass(id) { navigateFocus.current = 'detail'; change(classSelectionChange(query, id)); }
  function backToList() { navigateFocus.current = 'list'; change({ turma: null, secao: null, simulado: null }); }
  useEffect(() => {
    const target = navigateFocus.current === 'list' && !query.id ? listHeading.current
      : navigateFocus.current === 'detail' && detail.status === 'ready' ? detailHeading.current : null;
    if (!target) return;
    navigateFocus.current = null; target.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' });
  }, [query.id, detail.status]);
  function refresh() { list.retry(); detail.retry(); bootstrap.retry(); }
  function savedClass(id) { setModal(null); openClass(id); }
  const classes = !busySearch && list.status === 'ready' ? list.data : null;
  const hasSearch = Boolean(query.search.trim());
  const capabilities = bootstrap.data?.capabilities || {};
  const pendingSource = classSelectionChange(query, null).simulado;
  return <div data-classes className="mx-auto max-w-[1500px] bg-slate-50 px-4 py-4 text-slate-900 dark:bg-transparent dark:text-slate-100 sm:px-6">
    <header className={`flex flex-wrap items-center justify-between gap-2 ${query.id ? 'lg:mb-3' : 'mb-3'}`}>
      <h1 className={`text-2xl font-bold ${query.id ? 'sr-only lg:not-sr-only' : ''}`}>Turmas</h1>
      <button type="button" className={`${primary} ${query.id ? 'hidden lg:inline-flex' : ''}`} disabled={bootstrap.status !== 'ready'} onClick={() => setModal({ type: 'class', mode: 'create', bootstrap: bootstrap.data })}><Plus size={18} aria-hidden="true" />Criar turma</button>
    </header>
    {pendingSource && <section aria-label="Simulado selecionado" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
      <p>Escolha a turma para preparar este simulado.</p>
      <Link className="btn-outline" to={`/simulados/${encodeURIComponent(pendingSource)}`}>Voltar ao simulado</Link>
    </section>}
    {bootstrap.status === 'error' && <div className={`${materialSurface} mb-3 p-3`}><MaterialResourceState resource={bootstrap} label="as opções de cadastro" /></div>}
    <div className="grid items-start gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
      <section aria-label="Suas turmas" className={`${materialSurface} min-w-0 p-3 ${query.id ? 'hidden lg:block' : ''}`}>
        <h2 ref={listHeading} tabIndex={-1} className="mb-2 scroll-mt-28 text-base font-bold outline-none">Escolha uma turma</h2>
        <div className="relative mb-2"><Search size={17} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className={`input min-h-11 pl-10 ${materialFocus}`} aria-label="Buscar turma" placeholder="Buscar turma" maxLength={80} value={search} onChange={event => { searchChanged.current = true; setSearch(event.target.value); }} />
        </div>
        <div className="mb-2 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/5" aria-label="Situação das turmas">
          {['active', 'archived'].map(status => <button key={status} type="button" aria-pressed={query.status === status} className={`${button} ${query.status === status ? 'bg-white shadow-sm dark:bg-white/10' : ''}`} onClick={() => setStatus(status)}>{status === 'active' ? 'Ativas' : 'Arquivadas'}</button>)}
        </div>
        {busySearch ? <p role="status" className="py-3 text-sm">Atualizando a busca…</p> : <MaterialResourceState resource={list} label="suas turmas" />}
        {classes && (classes.length ? <div data-class-list className="space-y-2">
          {classes.map(item => <button key={item.id} type="button" onClick={() => openClass(item.id)} aria-current={query.id === item.id ? 'true' : undefined}
            className={`w-full rounded-xl border p-3 text-left ${materialFocus} ${query.id === item.id ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-400/10' : 'border-slate-200 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/5'}`}>
            <span className="flex items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-bold">{item.name}</span><ChevronRight size={18} aria-hidden="true" className="shrink-0" /></span>
            <span className="mt-1 block text-xs text-slate-600 dark:text-slate-300">{item.grade.name} · {item.academicYear} · {item.studentCount} {item.studentCount === 1 ? 'estudante' : 'estudantes'}</span>
          </button>)}
          {classes.length === 100 && <p className="pt-2 text-xs text-slate-600 dark:text-slate-300">Mostrando até 100 turmas. Use a busca para localizar outra.</p>}
        </div> : <div className="py-3 text-sm">
          <h3 className="font-bold">{hasSearch ? 'Nenhuma turma encontrada' : query.status === 'archived' ? 'Nenhuma turma arquivada' : 'Nenhuma turma ativa'}</h3>
          <p className="mt-1 text-slate-600 dark:text-slate-300">{hasSearch ? 'Não encontramos turmas nesta situação com o termo informado.' : query.status === 'archived' ? 'As turmas arquivadas ficarão guardadas aqui para consulta.' : 'Crie sua primeira turma e adicione os estudantes.'}</p>
          {hasSearch ? <button type="button" className={button} onClick={clearSearch}>Limpar busca</button> : query.status === 'archived' && <button type="button" className={button} onClick={() => setStatus('active')}>Ver turmas ativas</button>}
        </div>)}
      </section>
      <section aria-label="Turma selecionada" className={`${materialSurface} min-w-0 ${query.id ? '' : 'hidden lg:block'}`}>
        {query.id ? <>
          <button type="button" className={`${button} m-2 lg:hidden`} onClick={backToList}><ArrowLeft size={17} aria-hidden="true" />Voltar para turmas</button>
          <div className={detail.status === 'ready' ? '' : 'p-4'}><MaterialResourceState resource={detail} label="esta turma" /></div>
          {selected && <ClassDetail key={selected.id} schoolClass={selected} headingRef={detailHeading} section={query.section}
            initialAssessmentSourceId={query.source} requestedAssessmentId={query.assessment} capabilities={capabilities}
            onLaunchHandled={sourceId => setParams(current => current.get('turma') === selected.id && current.get('simulado') === String(sourceId)
              ? classNavigation(current, { simulado: null }) : current, { replace: true })}
            assessmentsEnabled={isEnabled('classes.assessment_assignments')} deliveryEnabled={isEnabled('classes.assessment_delivery')}
            resultsEnabled={isEnabled('classes.assessment_results')} studentPortalEnabled={isEnabled('classes.student_assessment_portal')} recoveryEnabled={isEnabled('classes.learning_recovery')}
            onSection={section => change({ secao: section === 'assessments' ? 'avaliacoes' : null, simulado: null })}
            canEditClass={bootstrap.status === 'ready'} onEdit={() => setModal({ type: 'class', mode: 'edit', schoolClass: selected, bootstrap: bootstrap.data })}
            onAddStudent={() => setModal({ type: 'student', mode: 'create', schoolClass: selected })}
            onEditStudent={student => setModal({ type: 'student', mode: 'edit', schoolClass: selected, student })}
            onImport={() => setModal({ type: 'import', schoolClass: selected })} onCodes={() => setModal({ type: 'codes', schoolClass: selected })}
            onStatus={() => setModal({ type: 'status', schoolClass: selected })}
            onEnrollment={student => setModal({ type: 'enrollment', schoolClass: selected, student })} />}
        </> : <div className="p-5 text-sm text-slate-600 dark:text-slate-300">Selecione uma turma para ver estudantes e aplicações.</div>}
      </section>
    </div>
    {!query.id && bootstrap.data && <details className="mt-3 text-sm text-slate-600 dark:text-slate-300"><summary className={`${button} w-fit cursor-pointer`}>Resumo das turmas</summary>
      <p className="px-3 py-2">{bootstrap.data.overview.activeClasses} turmas ativas · {bootstrap.data.overview.activeStudents} estudantes · {bootstrap.data.overview.activeEnrollments} matrículas ativas</p>
    </details>}
    {modal?.type === 'class' && modal.bootstrap && <ClassFormModal bootstrap={modal.bootstrap} config={modal} onClose={() => setModal(null)} onSaved={savedClass} onRefresh={refresh} />}
    {modal?.type === 'student' && <StudentFormModal config={modal} schoolClass={modal.schoolClass} onClose={() => setModal(null)} onSaved={() => setModal(null)} onRefresh={refresh} />}
    {modal?.type === 'import' && <ImportModal schoolClass={modal.schoolClass} onClose={() => setModal(null)} onImported={() => setModal(null)} onRefresh={refresh} />}
    {modal?.type === 'codes' && <CodesModal schoolClass={modal.schoolClass} onClose={() => setModal(null)} />}
    {['status', 'enrollment'].includes(modal?.type) && <ClassChangeModal config={modal} close={() => setModal(null)} refresh={refresh}
      onStatusChanged={status => change({ situacao: status === 'archived' ? status : null })} />}
  </div>;
}

function ClassChangeModal({ config, close, refresh, onStatusChanged }) {
  const { schoolClass, student } = config;
  const action = useMaterialAction(); const [error, setError] = useState('');
  const nextStatus = student ? (student.enrollmentStatus === 'active' ? 'withdrawn' : 'active') : (schoolClass.status === 'active' ? 'archived' : 'active');
  const label = student ? (nextStatus === 'withdrawn' ? 'Retirar estudante' : 'Rematricular estudante') : (nextStatus === 'archived' ? 'Arquivar turma' : 'Restaurar turma');
  return <Modal title={label + '?'} closeDisabled={action.busy} onClose={close}>
    <div className="space-y-3 p-4">
      <p className="break-words font-semibold text-slate-900 dark:text-white">{student?.displayName || schoolClass.name}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{student ? 'O histórico do estudante será preservado. Esta mudança vale apenas para esta turma.' : nextStatus === 'archived' ? 'A turma e seu histórico serão preservados. Os códigos de entrada ativos serão encerrados.' : 'A turma voltará para a lista de ativas. Códigos encerrados não serão reabertos.'}</p>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={button} disabled={action.busy} onClick={close}>Cancelar</button>
        <button type="button" className={primary} disabled={action.busy} onClick={() => action.run(() => api.patch(student ? `/classes/${schoolClass.id}/enrollments/${student.id}` : `/classes/${schoolClass.id}/status`,
          { status: nextStatus, expectedRevision: student ? student.enrollmentRevision : schoolClass.revision }, { timeout: 15000 }),
          { refresh, onError: setError, onSuccess: () => { close(); if (!student) onStatusChanged(nextStatus); }, message: student ? 'Matrícula atualizada. Histórico preservado.' : nextStatus === 'archived' ? 'Turma arquivada. Códigos ativos foram encerrados.' : 'Turma restaurada.' })}>{action.busy ? 'Aguarde…' : label}</button>
      </div>
    </div>
  </Modal>;
}

function ClassDetail({ schoolClass, headingRef, section, initialAssessmentSourceId, requestedAssessmentId, onLaunchHandled, capabilities, assessmentsEnabled, deliveryEnabled, resultsEnabled, studentPortalEnabled, recoveryEnabled, canEditClass, onSection, onEdit, onAddStudent, onEditStudent, onImport, onCodes, onStatus, onEnrollment }) {
  const [studentSearch, setStudentSearch] = useState('');
  const activeSection = assessmentsEnabled && section === 'avaliacoes' ? 'assessments' : 'students';
  const active = schoolClass.status === 'active';
  const enrolledCount = schoolClass.students.filter(student => student.enrollmentStatus === 'active').length;
  const students = useMemo(() => schoolClass.students.filter(student => studentMatches(student, studentSearch)), [schoolClass.students, studentSearch]);
  function tabKey(event) {
    const buttons = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const index = buttons.indexOf(document.activeElement);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].click(); buttons[next].focus();
  }
  return <div data-class-detail className="min-w-0 p-3 sm:p-4">
    <div className="mb-3">
      <h2 ref={headingRef} tabIndex={-1} className="scroll-mt-28 break-words text-xl font-bold outline-none">{schoolClass.name}</h2>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{schoolClass.grade.name} · {schoolClass.academicYear}{!active && ' · Arquivada'}</p>
      <p className="mt-1 break-words text-xs text-slate-600 dark:text-slate-300">{schoolClass.disciplines.map(item => item.name).join(', ')}</p>
    </div>
    <details className="group mb-2">
      <summary className={`${button} w-fit cursor-pointer`}>Organizar turma<ChevronRight size={16} aria-hidden="true" className="group-open:rotate-90" /></summary>
      <div className="flex flex-wrap gap-1 rounded-xl bg-slate-50 p-1 dark:bg-white/5">
        {active && <button type="button" className={button} disabled={!canEditClass} onClick={onEdit}><Pencil size={16} aria-hidden="true" />Editar turma</button>}
        {active && capabilities.importStudents && <button type="button" className={button} onClick={onImport}><FileSpreadsheet size={16} aria-hidden="true" />Importar estudantes</button>}
        {active && capabilities.entryCodes && <button type="button" className={button} onClick={onCodes}><KeyRound size={16} aria-hidden="true" />Código de entrada</button>}
        <button type="button" className={button} onClick={onStatus}>{active ? <Archive size={16} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}{active ? 'Arquivar turma' : 'Restaurar turma'}</button>
      </div>
    </details>
    {assessmentsEnabled && <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/5" role="tablist" aria-label="Conteúdo da turma" onKeyDown={tabKey}>
      {[['students', 'Estudantes'], ['assessments', 'Aplicações']].map(([key, label]) => <button key={key} id={`class-tab-${key}`} role="tab" type="button" aria-selected={activeSection === key} tabIndex={activeSection === key ? 0 : -1} aria-controls={`class-panel-${key}`}
        className={`${button} ${activeSection === key ? 'bg-white shadow-sm dark:bg-white/10' : ''}`} onClick={() => onSection(key)}>{label}</button>)}
    </div>}
    {activeSection === 'students' ? <div role={assessmentsEnabled ? 'tabpanel' : undefined} id="class-panel-students" aria-labelledby={assessmentsEnabled ? 'class-tab-students' : undefined}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold">{enrolledCount} {enrolledCount === 1 ? 'estudante' : 'estudantes'} na turma</h3>
        {active && <button type="button" className={button} onClick={onAddStudent}><UserPlus size={16} aria-hidden="true" />Adicionar</button>}
      </div>
      {schoolClass.students.length > 5 && <input aria-label="Buscar estudante" placeholder="Buscar estudante" className={`input mb-2 min-h-11 ${materialFocus}`} value={studentSearch} onChange={e => setStudentSearch(e.target.value)} />}
      {students.length ? <div data-class-students className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">
        {students.map(student => <div key={student.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 p-3">
          <div className="min-w-0 flex-1"><p className="break-words text-sm font-bold">{student.displayName}</p>
            <p className="break-words text-xs text-slate-600 dark:text-slate-300">{student.externalReference && `${student.externalReference} · `}{student.enrollmentStatus === 'active' ? 'Matriculado' : 'Retirado da turma'}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <button type="button" className={button} onClick={() => onEditStudent(student)} title="Editar estudante" aria-label={`Editar ${student.displayName}`}><Pencil size={16} aria-hidden="true" /></button>
            {active && <button type="button" className={button} onClick={() => onEnrollment(student)} aria-label={student.enrollmentStatus === 'active' ? `Retirar ${student.displayName}` : `Rematricular ${student.displayName}`}>{student.enrollmentStatus === 'active' ? <UserMinus size={16} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}</button>}
          </div>
        </div>)}
      </div> : <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-white/5"><h3 className="font-semibold">{studentSearch ? 'Nenhum estudante encontrado' : 'A turma ainda está vazia'}</h3>
        <p className="mt-1 text-slate-600 dark:text-slate-300">{studentSearch ? 'Confira o nome ou limpe a busca.' : active ? 'Use Adicionar para cadastrar um estudante. As outras opções estão em Organizar turma.' : 'Não há estudantes vinculados a esta turma.'}</p>
        {studentSearch && <button type="button" className={button} onClick={() => setStudentSearch('')}>Limpar busca de estudantes</button>}
      </div>}
    </div> : <div role="tabpanel" id="class-panel-assessments" aria-labelledby="class-tab-assessments">
      <ClassAssessments key={schoolClass.id} schoolClass={schoolClass} launchRequest={initialAssessmentSourceId ? 1 : 0} launchSourceQuestionSetId={initialAssessmentSourceId}
        onLaunchHandled={onLaunchHandled} requestedAssessmentId={requestedAssessmentId}
        deliveryEnabled={deliveryEnabled} resultsEnabled={resultsEnabled} studentPortalEnabled={studentPortalEnabled} recoveryEnabled={recoveryEnabled} />
    </div>}
  </div>;
}

function ClassFormModal({ bootstrap, config, onClose, onSaved, onRefresh }) {
  const source = config.schoolClass;
  const action = useMaterialAction();
  const [error, setError] = useState('');
  const [form, setForm] = useState(source ? { name: source.name, gradeId: String(source.grade.id), academicYear: String(source.academicYear), disciplineIds: source.disciplines.map(item => item.id) } : emptyClassForm);
  function submit(event) {
    event.preventDefault(); if (action.busy) return;
    if (!form.disciplineIds.length) { setError('Escolha pelo menos um componente curricular.'); return; }
    setError(''); let savedId;
    const payload = { name: form.name, gradeId: Number(form.gradeId), academicYear: Number(form.academicYear), disciplineIds: form.disciplineIds, expectedRevision: source?.revision };
    action.run(async () => {
      const response = source ? await api.put(`/classes/${source.id}`, payload, { timeout: 15000 }) : await api.post('/classes', payload, { timeout: 15000 });
      savedId = response.data.id;
    }, { onSuccess: () => onSaved(savedId), refresh: onRefresh, onError: setError, message: source ? 'Turma atualizada.' : 'Turma criada. Agora você pode adicionar estudantes.' });
  }
  return <Modal title={source ? 'Editar turma' : 'Nova turma'} onClose={onClose} closeDisabled={action.busy}>
    <form onSubmit={submit} className="space-y-3 p-4">
      <fieldset disabled={action.busy} className="space-y-3">
        <div><FieldLabel htmlFor="class-name">Nome da turma</FieldLabel><input id="class-name" required maxLength={120} className="input min-h-11" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ex.: 7º A — Manhã" /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><FieldLabel htmlFor="class-grade">Ano escolar</FieldLabel><select id="class-grade" required className="select min-h-11" value={form.gradeId} onChange={e => setForm({ ...form, gradeId: e.target.value })}><option value="">Selecione</option>{bootstrap.grades.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
          <div><FieldLabel htmlFor="class-year">Ano letivo</FieldLabel><input id="class-year" required type="number" min="2000" max={currentYear + 5} className="input min-h-11" value={form.academicYear} onChange={e => setForm({ ...form, academicYear: e.target.value })} /></div>
        </div>
        <fieldset><legend className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">Componentes curriculares</legend>
          <div className="grid max-h-44 gap-2 overflow-y-auto rounded-xl border border-slate-200 p-2 dark:border-white/10 sm:grid-cols-2">
            {bootstrap.disciplines.map(d => <button key={d.id} type="button" aria-pressed={form.disciplineIds.includes(d.id)} onClick={() => setForm(current => ({ ...current, disciplineIds: current.disciplineIds.includes(d.id) ? current.disciplineIds.filter(id => id !== d.id) : [...current.disciplineIds, d.id] }))}
              className={`${button} justify-start text-left ${form.disciplineIds.includes(d.id) ? 'bg-cyan-50 dark:bg-cyan-400/10' : ''}`}><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-cyan-600">{form.disciplineIds.includes(d.id) && <Check size={14} aria-hidden="true" />}</span>{d.name}</button>)}
          </div>
        </fieldset>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10"><button type="button" className={button} disabled={action.busy} onClick={onClose}>Cancelar</button><button type="submit" className={primary} disabled={action.busy}>{action.busy ? 'Salvando…' : source ? 'Salvar alterações' : 'Criar turma'}</button></div>
    </form>
  </Modal>;
}

function StudentFormModal({ config, schoolClass, onClose, onSaved, onRefresh }) {
  const source = config.student; const action = useMaterialAction(); const [error, setError] = useState('');
  const [form, setForm] = useState({ displayName: source?.displayName || '', externalReference: source?.externalReference || '' });
  function submit(event) {
    event.preventDefault(); setError('');
    action.run(() => source ? api.patch(`/classes/students/${source.id}`, { ...form, expectedRevision: source.revision }, { timeout: 15000 }) : api.post(`/classes/${schoolClass.id}/students`, form, { timeout: 15000 }),
      { onSuccess: onSaved, onError: setError, refresh: onRefresh, message: source ? 'Cadastro atualizado.' : 'Estudante adicionado à turma.' });
  }
  return <Modal title={source ? 'Editar estudante' : 'Adicionar estudante'} description={`Turma: ${schoolClass.name}`} onClose={onClose} closeDisabled={action.busy}>
    <form onSubmit={submit} className="space-y-3 p-4">
      <fieldset disabled={action.busy} className="space-y-3">
        <div><FieldLabel htmlFor="student-name">Nome do estudante</FieldLabel><input id="student-name" required maxLength={120} className="input min-h-11" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="Nome usado na chamada" /></div>
        <div><FieldLabel htmlFor="student-reference">Identificador ou matrícula (opcional)</FieldLabel><input id="student-reference" maxLength={80} className="input min-h-11" value={form.externalReference} aria-describedby="student-reference-hint" onChange={e => setForm({ ...form, externalReference: e.target.value })} placeholder="Ex.: 2026-0142" />
          <p id="student-reference-hint" className="mt-2 text-xs text-slate-600 dark:text-slate-300">Use apenas um identificador escolar, se necessário. Não informe CPF, e-mail pessoal ou outros dados desnecessários.</p></div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10"><button type="button" className={button} disabled={action.busy} onClick={onClose}>Cancelar</button><button type="submit" className={primary} disabled={action.busy}>{action.busy ? 'Salvando…' : 'Salvar'}</button></div>
    </form>
  </Modal>;
}

function ImportModal({ schoolClass, onClose, onImported, onRefresh }) {
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const previewRequest = useRef(null);
  const action = useMaterialAction();
  useEffect(() => () => previewRequest.current?.abort(), []);

  function downloadTemplate() {
    const content = '\uFEFFNome;Matrícula\nAna Silva;2026-001\nBruno Souza;2026-002\n';
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'modelo-estudantes-labmathic.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function previewFile(file) {
    if (!file || pending.current || action.busy) return;
    if (!/\.(csv|xlsx)$/i.test(file.name) || file.size > 1024 * 1024) { setError('Escolha um arquivo CSV ou XLSX com até 1 MB.'); return; }
    pending.current = true;
    setError(''); setPreview(null);
    const controller = new AbortController(); previewRequest.current = controller;
    setLoading(true);
    try {
      const data = new FormData();
      data.append('file', file);
      const response = await api.post(`/classes/${schoolClass.id}/import/preview`, data, { timeout: 15000, signal: controller.signal });
      if (controller.signal.aborted) return;
      setPreview(response.data);
    } catch (error) {
      if (!controller.signal.aborted) { setPreview(null); setError(error.response?.data?.error || 'Não foi possível conferir a planilha. Nenhuma matrícula foi alterada.'); }
    } finally {
      pending.current = false; if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function confirmImport() {
    if (!preview?.canImport) return;
    setError('');
    const rows = preview.rows.map(({ displayName, externalReference }) => ({ displayName, externalReference }));
    action.run(() => api.post(`/classes/${schoolClass.id}/import`, { rows }, { timeout: 15000 }), { onSuccess: onImported, onError: setError, refresh: onRefresh, message: 'Importação confirmada. Confira a lista da turma.' });
  }

  const labels = { create: 'Novo cadastro', enroll_existing: 'Vincular existente', reactivate: 'Rematricular', reactivate_by_name: 'Rematricular', skip: 'Já está na turma', invalid: 'Revisar' };
  return (
    <Modal title="Importar estudantes" description="Confira a planilha antes de confirmar. Nenhum estudante será adicionado nesta primeira etapa." onClose={onClose} closeDisabled={action.busy} width="max-w-3xl">
      <div className="space-y-5 p-5">
        {!preview && (
          <>
            <div className="rounded-2xl border border-dashed border-neutral-300 p-4 text-center dark:border-white/15">
              <FileSpreadsheet className="mx-auto text-emerald-500" size={38} />
              <p className="mt-3 font-bold text-neutral-800 dark:text-white">Envie um arquivo .xlsx ou .csv</p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">Até 1 MB e 500 estudantes. A coluna “Nome” é obrigatória.</p>
              <input ref={inputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(event) => previewFile(event.target.files?.[0])} />
              <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row"><button type="button" className="btn-primary" disabled={loading} onClick={() => inputRef.current?.click()}>{loading ? <RefreshCw className="animate-spin" size={17} /> : <FileSpreadsheet size={17} />} Selecionar planilha</button><button type="button" className="btn-outline" onClick={downloadTemplate}>Baixar modelo CSV</button></div>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">Use somente nome e, se necessário, um identificador escolar. Não inclua CPF, endereço, telefone ou e-mail pessoal.</p>
          </>
        )}
        {preview && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-xl bg-slate-50 p-3 text-sm dark:bg-white/5">{Object.entries(preview.summary).map(([key, value]) => <p key={key}><strong>{value}</strong> · {labels[key]}</p>)}</div>
            <div className="max-h-72 overflow-auto rounded-2xl border border-neutral-200 dark:border-white/10">
              {preview.rows.map((row) => <div key={row.rowNumber} data-import-row className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1 border-b border-neutral-100 p-3 last:border-b-0 dark:border-white/5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className="text-xs font-bold text-slate-600 dark:text-slate-300">{row.rowNumber}</span>
                <div className="min-w-0"><p data-import-name className="break-words text-sm font-bold text-neutral-800 dark:text-white">{row.displayName || 'Nome inválido'}</p><p className="break-words text-xs text-slate-600 dark:text-slate-300">{row.externalReference || 'Sem identificador'}</p>{row.errors.map((error) => <p key={error} className="mt-1 break-words text-xs font-semibold text-red-700 dark:text-red-300">{error}</p>)}</div>
                <span className={`col-start-2 w-fit rounded-full px-2 py-1 text-xs font-semibold sm:col-start-auto ${row.action === 'invalid' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' : row.action === 'skip' ? 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'}`}>{labels[row.action]}</span>
              </div>)}
            </div>
            {!preview.canImport && <div className="flex gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-200"><CircleAlert className="shrink-0" size={18} /> Corrija as linhas indicadas na planilha e envie novamente.</div>}
            <div className="flex flex-col-reverse justify-end gap-2 border-t border-neutral-100 pt-4 dark:border-white/10 sm:flex-row"><button type="button" className={button} disabled={action.busy} onClick={() => setPreview(null)}>Escolher outro arquivo</button><button type="button" className={primary} disabled={!preview.canImport || loading || action.busy} onClick={confirmImport}>{action.busy ? 'Importando…' : 'Confirmar importação'}</button></div>
          </>
        )}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </div>
    </Modal>
  );
}

function parseClassCodes(value) {
  if (!Array.isArray(value) || value.some(code => !code || typeof code.id !== 'string' || !Number.isInteger(code.revision) || typeof code.expiresAt !== 'string'
    || !Number.isInteger(code.maxUses) || !Number.isInteger(code.useCount) || !['active', 'revoked', 'closed'].includes(code.status))) throw new Error('Códigos não confirmados.');
  return value;
}
function CodesModal({ schoolClass, onClose }) {
  const toast = useToast(); const action = useMaterialAction();
  const codes = useReadOnlyResource(`/classes/${schoolClass.id}/codes`, schoolClass.id, parseClassCodes);
  const [form, setForm] = useState({ maxUses: '35', validDays: '7' });
  const [generated, setGenerated] = useState(null); const [error, setError] = useState('');
  function generate(event) {
    event.preventDefault(); setError(''); let result;
    action.run(async () => { const response = await api.post(`/classes/${schoolClass.id}/codes`, { maxUses: Number(form.maxUses), validDays: Number(form.validDays) }, { timeout: 15000 }); result = response.data; },
      { onSuccess: () => setGenerated(result), refresh: codes.retry, onError: setError, message: 'Código criado. Copie antes de fechar esta janela.' });
  }
  async function copy(value, label) {
    try { await navigator.clipboard.writeText(value); toast.success(`${label} copiado.`); }
    catch { setError('O navegador não permitiu copiar. Selecione e copie o código exibido.'); }
  }
  function revoke(code) {
    if (!window.confirm('Revogar este código agora? Ele deixará de aceitar novas entradas.')) return;
    setError('');
    action.run(() => api.post(`/classes/${schoolClass.id}/codes/${code.id}/revoke`, { expectedRevision: code.revision }, { timeout: 15000 }),
      { refresh: codes.retry, onError: setError, onSuccess: () => setGenerated(current => current?.id === code.id ? null : current), message: 'Código revogado.' });
  }
  const shareUrl = generated ? `${window.location.origin}/entrar-na-turma?codigo=${encodeURIComponent(generated.code)}` : '';
  return <Modal title="Código de entrada" description="Permita que estudantes entrem nesta turma usando um código temporário." onClose={onClose} closeDisabled={action.busy} width="max-w-2xl">
    <div className="space-y-3 p-4">
      {generated && <div className="rounded-xl bg-violet-50 p-3 text-violet-900 dark:bg-violet-400/10 dark:text-violet-100">
        <p className="text-sm font-semibold">Copie agora. O código não será mostrado novamente.</p>
        <p data-generated-code className="my-3 break-all font-mono text-xl font-bold">{generated.code}</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => copy(generated.code, 'Código')}><ClipboardCopy size={16} aria-hidden="true" />Copiar código</button><button type="button" className={button} onClick={() => copy(shareUrl, 'Link')}>Copiar link de entrada</button></div>
      </div>}
      <form onSubmit={generate}>
        <fieldset disabled={action.busy} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><FieldLabel htmlFor="class-code-uses">Quantidade máxima de entradas</FieldLabel><input id="class-code-uses" type="number" min="1" max="500" required className="input min-h-11" value={form.maxUses} onChange={e => setForm({ ...form, maxUses: e.target.value })} /></div>
            <div><FieldLabel htmlFor="class-code-days">Validade</FieldLabel><select id="class-code-days" className="select min-h-11" value={form.validDays} onChange={e => setForm({ ...form, validDays: e.target.value })}><option value="1">1 dia</option><option value="3">3 dias</option><option value="7">7 dias</option><option value="14">14 dias</option></select></div>
          </div>
          <button type="submit" className={primary} disabled={codes.status !== 'ready'}>{action.busy ? 'Aguarde…' : 'Gerar código de entrada'}</button>
        </fieldset>
      </form>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Histórico recente</h3>
      <MaterialResourceState resource={codes} label="os códigos desta turma" />
      {codes.status === 'ready' && (codes.data.length ? <div className="space-y-2">{codes.data.map(code => <div key={code.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-3 dark:bg-white/5">
        <div className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200"><p>{code.useCount} de {code.maxUses} entradas utilizadas</p><p className="text-xs">Expira em {new Date(code.expiresAt).toLocaleDateString('pt-BR')} · {code.status === 'active' ? 'Ativo' : code.status === 'revoked' ? 'Revogado' : 'Encerrado'}</p></div>
        {code.status === 'active' && <button type="button" className={button} disabled={action.busy} onClick={() => revoke(code)}>Revogar</button>}
      </div>)}</div> : <p className="text-sm text-slate-600 dark:text-slate-300">Nenhum código criado para esta turma.</p>)}
    </div>
  </Modal>;
}
