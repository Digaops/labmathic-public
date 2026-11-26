import {cloneElement,useCallback,useId,useRef,useState} from 'react';
import AssessmentDialog from './AssessmentDialog';
import PlannerResourceButton from './PlannerResourceButton';
import usePlannerCatalog from '../hooks/usePlannerCatalog';
import {usePlannerLeave} from '../hooks/usePlannerSession';
import {parsePlannerSkills,parsePlannerResourcePage,same} from '../services/lessonPlannerView.mjs';

export function PlannerField({label,children}){const id=useId();return <div className="text-sm font-semibold"><label className="block" htmlFor={id}>{label}</label><div className="mt-1">{cloneElement(children,{id})}</div></div>;}
export function PlannerReadState({result}){return result.loading?<p role="status" className="py-3 text-sm">Carregando opções…</p>:result.error?<div role="alert" className="rounded-xl border border-amber-300 p-3 text-sm"><p>{result.error}</p><button type="button" className="btn-outline mt-2" onClick={result.retry}>Tentar novamente</button></div>:null;}
function PickerShell({title,dirty,onClose,children}){
  const leave=usePlannerLeave(dirty,()=>false);
  const close=()=>{if(leave(onClose))onClose();};
  return <AssessmentDialog title={title} onClose={close}><div className="bank-form space-y-3 p-3">{children}<button type="button" className="btn-outline" onClick={close}>Cancelar</button></div></AssessmentDialog>;
}
export function PlannerSkillPicker({grades,selected,defaultGradeId,onClose,onConfirm}){
  const [grade,setGrade]=useState(defaultGradeId||grades[0]?.id||''),[unit,setUnit]=useState(''),[chosen,setChosen]=useState(selected),[error,setError]=useState('');
  const result=usePlannerCatalog(grade?'/lesson-plans/catalog/skills?'+new URLSearchParams({gradeId:grade,unitId:unit}):null,parsePlannerSkills);
  function toggle(skill){if(chosen.some(s=>s.id===skill.id)){setChosen(chosen.filter(s=>s.id!==skill.id));setError('');}else if(chosen.length===10)setError('Selecione no máximo 10 habilidades por aula.');else{setChosen([...chosen,skill]);setError('');}}
  return <PickerShell title="Habilidades BNCC" dirty={!same(chosen,selected)} onClose={onClose}>
    <p className="text-sm">Você pode retomar habilidades de outros anos. A seleção permanece ao trocar os filtros.</p>
    <div className="grid gap-3 sm:grid-cols-2"><PlannerField label="Ano da habilidade"><select className="input w-full" value={grade} onChange={e=>{setGrade(e.target.value);setUnit('');}}>{grades.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></PlannerField><PlannerField label="Unidade temática"><select className="input w-full" value={unit} onChange={e=>setUnit(e.target.value)} disabled={!result.data}><option value="">Todas</option>{result.data?.units.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></PlannerField></div>
    <details><summary className="cursor-pointer text-sm font-semibold">Selecionadas · {chosen.length}/10</summary><ul>{chosen.map(s=><li className="flex items-center justify-between gap-2 text-sm" key={s.id??s.code}><span>{s.code} · {s.description}</span><button type="button" className="btn-outline shrink-0" aria-label={'Remover '+s.code} onClick={()=>setChosen(chosen.filter(x=>x!==s))}>Remover</button></li>)}</ul></details>
    <PlannerReadState result={result}/>{error&&<p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{error}</p>}
    {result.data?.skills.length===0&&<p className="text-sm">Nenhuma habilidade neste filtro.</p>}
    <div className="space-y-2">{result.data?.skills.map(s=><label key={s.id} className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-white/10"><input type="checkbox" className="mt-1" checked={chosen.some(x=>x.id===s.id)} onChange={()=>toggle(s)}/><span><strong>{s.code}</strong><span className="mt-1 block">{s.description}</span></span></label>)}</div>
    <button type="button" className="btn-primary" disabled={!chosen.length} onClick={()=>onConfirm(chosen)}>Confirmar habilidades</button>
  </PickerShell>;
}
const resourceTabs=[['materials','Materiais','material'],['questions','Questões','question'],['questionSets','Simulados','question_set'],['activity','Atividade própria','activity']];
export function PlannerResourcePicker({lesson,gradeId,disciplineId,onClose,onConfirm}){
  const [chosen,setChosen]=useState(lesson.resources),[tab,setTab]=useState('materials');
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(1);
  const [title,setTitle]=useState(''),[notes,setNotes]=useState(''),[error,setError]=useState('');
  const searchInput=useRef(null),resultStart=useRef(null);
  const parse=useCallback(value=>parsePlannerResourcePage(value,{category:tab,page}),[tab,page]);
  const path=tab==='activity'?null:'/lesson-plans/catalog/resources?'+new URLSearchParams({
    category:tab,search:query,page:String(page),skillIds:lesson.skills.map(s=>s.id).join(','),
    ...(gradeId?{gradeId}:{}),...(disciplineId?{disciplineId}:{}),
  });
  const result=usePlannerCatalog(path,parse),type=resourceTabs.find(t=>t[0]===tab)[2];
  function changeTab(value){setTab(value);setSearch('');setQuery('');setPage(1);setError('');}
  function searchCatalog(event){event.preventDefault();setQuery(search.trim());setPage(1);if(search.trim()===query&&page===1)result.retry();}
  function clearSearch(){setSearch('');setQuery('');setPage(1);searchInput.current?.focus();}
  function changePage(next){setPage(next);resultStart.current?.focus();resultStart.current?.scrollIntoView({block:'start'});}
  function add(resource){if(chosen.length>=50){setError('Use no máximo 50 recursos por aula.');return false;}setChosen([...chosen,resource]);setError('');return true;}
  function toggle(item){const exists=chosen.some(r=>r.type===type&&r.id===item.id);if(exists)setChosen(chosen.filter(r=>!(r.type===type&&r.id===item.id)));else add({type,id:item.id,title:item.title,notes:''});}
  return <PickerShell title="Recursos da aula" dirty={!same(chosen,lesson.resources)||Boolean(title||notes)} onClose={onClose}>
    <p className="text-sm">Busque no acervo disponível para as habilidades e a turma desta aula. Suas escolhas permanecem ao mudar de página ou tipo de recurso.</p>
    <PlannerField label="Tipo de recurso"><select className="input w-full" value={tab} onChange={e=>changeTab(e.target.value)}>{resourceTabs.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></PlannerField>
    <details><summary className="cursor-pointer text-sm font-semibold">Selecionados · {chosen.length}/50</summary><ul>{chosen.map((r,i)=><li key={i} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"><div className="min-w-0 flex-1 basis-48 break-words"><strong>{r.title}</strong><p className="whitespace-pre-wrap">{r.notes}</p></div><div className="flex flex-wrap gap-2"><PlannerResourceButton resource={r}/><button type="button" className="btn-outline shrink-0" aria-label={'Remover recurso '+(i+1)} onClick={()=>setChosen(chosen.filter((_,j)=>j!==i))}>Remover</button></div></li>)}</ul></details>
    {error&&<p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{error}</p>}
    {tab==='activity'?<div className="space-y-3"><PlannerField label="Atividade"><input className="input w-full" maxLength={240} value={title} onChange={e=>setTitle(e.target.value)}/></PlannerField><PlannerField label="Orientações"><textarea className="input min-h-24 w-full" maxLength={2000} value={notes} onChange={e=>setNotes(e.target.value)}/></PlannerField><button type="button" className="btn-outline" disabled={!title.trim()} onClick={()=>{if(add({type:'activity',id:null,title:title.trim(),notes:notes.trim()})){setTitle('');setNotes('');}}}>Adicionar atividade</button></div>:<>
      <form className="flex flex-wrap items-end gap-2" onSubmit={searchCatalog}>
        <div className="min-w-0 flex-1"><PlannerField label="Buscar no acervo"><input ref={searchInput} type="search" className="input w-full" maxLength={100} value={search} onChange={e=>setSearch(e.target.value)} placeholder={tab==='questions'?'Texto ou código da questão':'Título ou palavra-chave'}/></PlannerField></div>
        <button type="submit" className="btn-outline">Buscar</button>
        {(query||search)&&<button type="button" className="btn-outline" onClick={clearSearch}>Limpar busca</button>}
      </form>
      <PlannerReadState result={result}/>
      <div ref={resultStart} tabIndex={-1} aria-live="polite" aria-atomic="true" className="text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-600">
        {result.data&&<p>{result.data.total} {result.data.total===1?'recurso encontrado':'recursos encontrados'}{query?` para “${query}”`:''}{result.data.total>0?` · Página ${page} de ${result.data.totalPages}`:''}</p>}
      </div>
      {result.data?.items.length===0&&<p className="text-sm">{query?'Tente outra palavra ou limpe a busca.':'Não há recursos disponíveis neste filtro.'} Você também pode escolher “Atividade própria” e descrever o que fará na aula.</p>}
      <div className="divide-y divide-slate-200 dark:divide-white/10">{result.data?.items.map(item=><div key={item.id} className="flex flex-wrap items-start justify-between gap-2 py-3"><label className="flex min-h-11 min-w-0 flex-1 basis-48 cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={chosen.some(r=>r.type===type&&r.id===item.id)} onChange={()=>toggle(item)}/><span className="min-w-0 break-words"><strong>{item.code?item.code+' · ':''}{item.title}</strong><span className="mt-1 block">{tab==='materials'?(item.skillMatch?'Associado à habilidade no acervo':'Sugestão do acervo: confira a adequação'):item.skillCode||item.questionCount+' questões relacionadas às habilidades'}</span></span></label><PlannerResourceButton resource={{type,id:item.id,title:item.title}}/></div>)}</div>
      {result.data&&(result.data.totalPages>1||page>1)&&<nav aria-label="Páginas dos recursos" className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-outline" disabled={page===1} onClick={()=>changePage(page-1)}>Página anterior</button>
        <button type="button" className="btn-outline" disabled={page>=result.data.totalPages} onClick={()=>changePage(page+1)}>Próxima página</button>
      </nav>}
    </>}
    {(title||notes)&&<p className="text-sm">Adicione a atividade escrita acima antes de confirmar, ou limpe os campos.</p>}
    <button type="button" className="btn-primary" disabled={Boolean(title||notes)} onClick={()=>onConfirm(chosen)}>Confirmar recursos</button>
  </PickerShell>;
}
