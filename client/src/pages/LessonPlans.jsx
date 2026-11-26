import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import usePlannerCatalog from '../hooks/usePlannerCatalog';
import {parsePlannerList,plannerDate,plannerQuery,planStatuses} from '../services/lessonPlannerView.mjs';

export default function LessonPlans(){
  const [params,setParams]=useSearchParams(),query=plannerQuery(params);
  const [search,setSearch]=useState(query.search);
  useEffect(()=>setSearch(query.search),[query.search]);
  const result=usePlannerCatalog('/lesson-plans?'+new URLSearchParams({search:query.search,status:query.status}),parsePlannerList);
  const plans=result.data?.plans||[],pages=Math.max(1,Math.ceil(plans.length/20)),page=Math.min(pages,query.page);
  function filter(values){const next=new URLSearchParams(params);for(const [key,value] of Object.entries(values)){if(value)next.set(key,value);else next.delete(key);}setParams(next);}
  const suffix=params.toString()?'?'+params:'';
  return <div data-lesson-plans className="editorial-workspace bank-form mx-auto max-w-6xl space-y-4 px-3 pt-3 pb-8 sm:px-6 sm:pt-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">Planejamento de aulas</h1><p className="mt-1 text-sm">Prepare as aulas, registre o que aconteceu e consulte suas sequências.</p></div><Link className="btn-primary" to={'/planejamento/novo'+suffix}>Criar planejamento</Link></header>
    <form className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[1fr_auto_auto]" onSubmit={e=>{e.preventDefault();filter({busca:search.trim(),pagina:''});}}>
      <label className="block text-sm font-semibold">Buscar planejamento<input type="search" className="input mt-1 w-full" maxLength={100} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Título ou turma"/></label>
      <button className="btn-outline self-end sm:col-start-3" type="submit">Buscar</button>
      <details className="col-span-2 self-end sm:col-span-1 sm:col-start-2 sm:row-start-1"><summary className="cursor-pointer text-sm font-semibold">Situação: {planStatuses[query.status]||'Todas'}</summary><label className="block text-sm font-semibold" htmlFor="planner-status">Filtrar por situação</label><select id="planner-status" className="input mt-1 w-full" value={query.status} onChange={e=>filter({situacao:e.target.value,pagina:''})}><option value="">Todas</option>{Object.entries(planStatuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></details>
    </form>
    {result.loading?<p role="status" className="p-3">Carregando planejamentos…</p>:result.error?<div role="alert" className="rounded-xl border border-amber-300 p-3"><p>{result.error}</p><button className="btn-outline mt-2" onClick={result.retry}>Tentar novamente</button></div>:plans.length===0?<section className="rounded-xl border border-slate-200 p-4 dark:border-white/10"><h2 className="font-bold">{query.search?'Nenhum planejamento neste filtro':query.status==='archived'?'Nenhum planejamento arquivado':query.status?'Nenhum planejamento nesta situação':'Você ainda não criou um planejamento'}</h2><p className="mt-1 text-sm">{query.search||query.status?'Experimente outra busca ou limpe os filtros.':'Comece com uma aula. Você poderá ampliar a sequência depois.'}</p>{(query.search||query.status)&&<button className="btn-outline mt-3" onClick={()=>setParams({})}>Limpar filtros</button>}</section>:<>
      <p className="text-sm">{plans.length} planejamentos encontrados{plans.length===100?' · A consulta mostra até 100. Use os filtros para localizar outros.':''}</p>
      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">{plans.slice((page-1)*20,page*20).map(p=><li key={p.publicId} data-planner-row={p.publicId} className="p-3 sm:p-4">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><h2 className="font-bold">{p.title}</h2><p className="mt-1 text-sm">{p.className||'Turma indisponível'} · {p.taughtCount}/{p.lessonCount} aulas realizadas · {planStatuses[p.status]}</p></div><Link className="btn-outline shrink-0" to={'/planejamento/'+p.publicId+suffix}>{p.status==='draft'?'Continuar planejamento':p.status==='active'?'Registrar aulas':'Consultar histórico'}</Link></div>
        <details><summary className="cursor-pointer text-sm font-semibold text-cyan-700 dark:text-cyan-300">Período e componente</summary><p className="text-sm">{plannerDate(p.startsOn)} a {plannerDate(p.endsOn)} · {p.gradeName} · {p.disciplineName||'Componente indisponível'}</p></details>
      </li>)}</ul>
      {pages>1&&<nav aria-label="Páginas dos planejamentos" className="flex flex-wrap items-center gap-3"><button className="btn-outline" disabled={page===1} onClick={()=>filter({pagina:String(page-1)})}>Anterior</button><span>{page} de {pages}</span><button className="btn-outline" disabled={page===pages} onClick={()=>filter({pagina:String(page+1)})}>Próxima</button></nav>}
    </>}
  </div>;
}
