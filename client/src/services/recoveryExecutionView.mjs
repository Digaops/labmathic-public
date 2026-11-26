import { parseRecoveryPlan } from './recoveryPlansView.mjs';
import { validateRecoveryComparison } from './recoveryComparisonView.mjs';

const fail = () => { throw new Error('Resposta da execução incompleta.'); };
const text = v => typeof v === 'string' && v.length > 0;
const integer = v => Number.isSafeInteger(v) && v >= 0;
export const lessonLabels = { planned:'Planejada', taught:'Realizada', skipped:'Não realizada' };
export function lessonFields(lesson) {
  return {plannedDate:lesson.plannedDate || '',durationMinutes:String(lesson.durationMinutes ?? 50),teacherNotes:lesson.teacherNotes || ''};
}
export const sameFields = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function lessonError(fields, phase, status) {
  const date = new Date(fields.plannedDate+'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.plannedDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==fields.plannedDate) return 'Informe uma data válida.';
  const duration=Number(fields.durationMinutes);
  if (!Number.isInteger(duration) || duration<10 || duration>600) return 'A duração deve ser de 10 a 600 minutos.';
  if (phase==='monitoring' && status==='skipped' && fields.teacherNotes.trim().length<10) return 'Explique em pelo menos 10 caracteres por que a verificação não foi realizada.';
  return '';
}
export function parseExecutionPlan(value, expected) {
  const plan=parseRecoveryPlan(value);
  if (plan.id!==expected.id || plan.class.id!==expected.class.id || plan.sourceAssessment.id!==expected.sourceAssessment.id) fail();
  const ex=plan.execution;
  if (!ex) {if(expected.execution)fail();return plan;}
  if (!text(ex.id) || !integer(ex.revision) || !ex.revision || !['active','completed','archived','draft'].includes(ex.status)
    || !['total','handled','planned','taught','skipped','percentage'].every(k=>integer(ex.progress?.[k])) || ex.progress.percentage>100) fail();
  if(!Array.isArray(ex.lessons)||ex.lessons.length!==ex.progress.total||new Set(ex.lessons.map(l=>l.id)).size!==ex.lessons.length)fail();
  if(expected.execution && expected.execution.lessons.some(l=>!ex.lessons.some(n=>n.id===l.id)))fail();
  ex.lessons.forEach(l=>{
    if(!text(l.id)||!text(l.title)||!integer(l.revision)||!l.revision||!Object.hasOwn(lessonLabels,l.status)||!['intervention','monitoring'].includes(l.phase)||!Array.isArray(l.skills)||!Array.isArray(l.resources))fail();
    l.skills.forEach(s=>{if(!text(s.code))fail();});l.resources.forEach(r=>{if(!text(r.title))fail();});
  });
  if (ex.monitoring) {
    const m=ex.monitoring;
    if(!['needs_application','draft','scheduled','open','awaiting_results','cancelled','evidence_ready'].includes(m.state)||m.class?.id!==plan.class.id||!integer(m.questionSet?.id))fail();
    if(m.state==='evidence_ready'&&(!Array.isArray(m.comparison?.skills)||!Array.isArray(m.comparison?.studentsNeedingFollowUp)))fail();
    if(m.state==='evidence_ready')validateRecoveryComparison(m.comparison);
  }
  return plan;
}
export function resourceOptions(value, lessonId) {
  if (!value || value.lesson?.id!==lessonId || !integer(value.executionRevision) || typeof value.editable!=='boolean'
    || !Array.isArray(value.questions)||!Array.isArray(value.materials)||!integer(value.limits?.maxQuestions)||!integer(value.limits?.maxMaterials))fail();
  value.questions.forEach(q=>{if(!integer(q.id)||!text(q.code)||!text(q.statement)||typeof q.selected!=='boolean')fail();});
  value.materials.forEach(m=>{if(!integer(m.id)||!text(m.title)||typeof m.selected!=='boolean'||(m.needsReview!==undefined&&typeof m.needsReview!=='boolean'))fail();});return value;
}
export function monitoringOptions(value) {
  if(!value || typeof value.ready!=='boolean'||!Array.isArray(value.skills))fail();
  if(value.existing)return value;
  if(!integer(value.executionRevision)||!Array.isArray(value.warnings))fail();
  value.skills.forEach(s=>{if(!text(s.skill?.code)||!Array.isArray(s.questions))fail();s.questions.forEach(q=>{if(!integer(q.id)||!text(q.code)||!text(q.statement))fail();});});
  if(value.selectionMethodology==='unused-questions-v2'){
    if(new Set(value.skills.map(s=>s.skill.code)).size!==value.skills.length)fail();
    const ids=value.skills.flatMap(s=>s.questions.map(q=>q.id));
    if(new Set(ids).size!==ids.length||value.questionCount!==ids.length)fail();
    value.skills.forEach(s=>{
      if(s.minimum!==1||s.recommended!==2||!['available','no_questions','skill_unavailable'].includes(s.availability)
        ||s.questions.length>2||(s.availability==='available')!==(s.questions.length>0)
        ||s.questions.some(q=>q.id<1||typeof q.selected!=='boolean'))fail();
    });
    if(value.ready!==(value.skills.length>0&&value.skills.every(s=>s.questions.length>=1)))fail();
  }
  return value;
}
export function canPrepareMonitoring(options, selected) {
  return Boolean(options?.ready && options.skills.length && selected.length>0 && selected.length<=50
    && new Set(selected).size===selected.length && options.skills.every(s=>s.questions.some(q=>selected.includes(q.id)))
    && selected.every(id=>options.skills.some(s=>s.questions.some(q=>q.id===id))));
}
export function mergeLessonDrafts(drafts, execution) {
  const next={};
  for (const lesson of execution?.lessons || []) {
    const current=drafts[lesson.id],fields=lessonFields(lesson);
    // Resource updates must not erase a local note; keep its original revision if fields changed elsewhere.
    next[lesson.id]=current && !sameFields(current.fields,current.saved)
      ? {...current,revision:sameFields(current.saved,fields)?lesson.revision:current.revision}
      : {fields,saved:fields,revision:lesson.revision};
  }
  return next;
}
