import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import useHomeResource from '../hooks/useHomeResource';
import SchoolCoordinationSkills from '../components/SchoolCoordinationSkills';
import SchoolCoordinationSupport from '../components/SchoolCoordinationSupport';
import { coordinationParams, coordinationQuery } from '../services/schoolCoordinationNavigation.mjs';
import { coordinationCount, coordinationDate, coordinationResultText, parseCoordinationClasses, parseCoordinationSchools } from '../services/schoolCoordinationView.mjs';

const button = 'inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 px-3 text-sm font-semibold disabled:opacity-50 dark:border-white/20';
const muted = 'text-sm leading-6 text-slate-600 dark:text-slate-300';
const surface = 'rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31]';

export default function SchoolCoordination() {
  const { user, announcementAccessId } = useAuth();
  const identity = `${user.id}:${user.role}:${announcementAccessId}`;
  return <Workspace key={identity} identity={identity} />;
}
function Workspace({ identity }) {
  const [params, setParams] = useSearchParams();
  const { selected, page, year, search, classSearch, url } = coordinationQuery(params);
  const resource = useHomeResource(url, identity, selected ? parseCoordinationClasses : parseCoordinationSchools);
  const [skills, setSkills] = useState(null);
  const [support, setSupport] = useState(null);
  useEffect(() => { setSkills(null); setSupport(null); }, [url]);
  const update = values => setParams(coordinationParams(params, values));
  return <div data-school-coordination className="mx-auto max-w-5xl space-y-3 bg-slate-50 px-3 py-3 text-slate-900 dark:bg-transparent dark:text-slate-100 sm:px-5">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-bold">Acompanhamento da escola</h1><button className={button} onClick={resource.retry} disabled={resource.status === 'loading'}>Atualizar</button></header>
    <p className={muted}>Veja o andamento das avaliações e converse com os professores sobre os próximos passos.</p>
    <nav className="flex flex-wrap gap-2" aria-label="Navegação escolar"><Link className={button} to="/instituicoes">Escolas e rede</Link>{selected && <button className={button} onClick={() => update({ escola: null, pagina: null, ano: null, turma: null })}>Trocar escola</button>}</nav>
    <Filters key={`${selected}:${year}:${search}:${classSearch}`} selected={selected} year={year} search={search} classSearch={classSearch} update={update} />
    {resource.status === 'loading' && <p role="status" className={muted}>Conferindo o acesso e consultando as turmas…</p>}
    {resource.status === 'error' && <div role="alert" className={surface}><p>Não foi possível consultar estes dados. Confira a conexão e tente atualizar.</p><p className={`mt-1 ${muted}`}>Se continuar, peça à administração para conferir a liberação do recurso e seu vínculo de gestão ou coordenação. Os dados anteriores não são mantidos nesta tela.</p></div>}
    {resource.status === 'ready' && <section className="space-y-3" aria-label={selected ? 'Turmas da escola' : 'Escolas autorizadas'}>
      {selected && <div><h2 className="break-words text-lg font-bold">{resource.data.school.name}</h2><p className={muted}>{resource.data.school.municipality} · {year ? `Ano letivo ${year}` : 'Todos os anos letivos'} · {coordinationCount(resource.data.total, 'turma ativa confirmada', 'turmas ativas confirmadas')}</p>{classSearch && <p className={`${muted} [overflow-wrap:anywhere]`}>Busca por “{classSearch}” em todas as páginas desta escola.</p>}</div>}
      {!resource.data.items.length ? <div className={surface}><h2 className="font-semibold">{selected ? 'Nenhuma turma disponível neste recorte' : 'Nenhuma escola disponível nesta consulta'}</h2><p className={`mt-1 ${muted}`}>{selected ? 'Confira a busca e o ano letivo. A turma precisa estar ativa, com escola confirmada e professor com vínculo ativo.' : 'Tente outra busca. O vínculo de professor, sozinho, não libera o acompanhamento da escola. Peça à administração para conferir sua função.'}</p>{page > 1 && <button className={`${button} mt-2`} onClick={() => update({ pagina: null })}>Voltar à primeira página</button>}</div>
        : <ul className="space-y-2">{resource.data.items.map(row => <li className={surface} key={row.id}>
          {selected ? <><h3 className="break-words font-bold">{row.name}</h3><p className={muted}>{row.gradeName} · {row.academicYear}</p>
            <p className="mt-2 text-sm">{coordinationCount(row.openCount, 'avaliação aberta', 'avaliações abertas')} · {coordinationCount(row.closedCount, 'encerrada', 'encerradas')}</p>
            <p className="mt-2 text-sm font-semibold">{row.result ? `Última avaliação encerrada · ${coordinationDate(row.result.closedAt)}` : 'Resultados da turma'}</p>
            <p className={`mt-1 ${muted}`}>{coordinationResultText(row.result)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {row.result && <button className={button} onClick={() => { setSupport(null); setSkills({ classId: row.id, url }); }} aria-label={`Ver habilidades de ${row.name}`}>Ver habilidades</button>}
              <button className={button} onClick={() => { setSkills(null); setSupport({ classId: row.id, url }); }} aria-label={`Acompanhar apoio de ${row.name}`}>Acompanhar apoio</button>
            </div>
          </> : <><h2 className="break-words font-bold">{row.name}</h2><p className={muted}>{row.municipality}</p><button className={`${button} mt-2`} onClick={() => update({ escola: row.id, pagina: null })}>Ver turmas</button></>}
        </li>)}</ul>}
      <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Páginas da consulta"><button className={button} disabled={page === 1} onClick={() => update({ pagina: page - 1 })}>Anterior</button><span className="text-sm">Página {page} · {coordinationCount(resource.data.total, selected ? 'turma' : 'escola', selected ? 'turmas' : 'escolas')}</span><button className={button} disabled={page * 20 >= resource.data.total || page >= 9999} onClick={() => update({ pagina: page + 1 })}>Próxima</button></nav>
    </section>}
    <details className={surface}><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">O que estes números mostram?</summary><div className={`space-y-2 ${muted}`}>
      <p>Somente turmas ativas com escola confirmada e vínculo docente ativo entram na consulta. Avaliações em rascunho, agendadas ou canceladas não entram nas contagens.</p>
      <p>O resultado é da avaliação encerrada mais recentemente em cada turma, não da melhor nota nem de todo o período. Ele pode mudar se o professor concluir ou revisar correções.</p>
      <p>A média considera apenas correções concluídas, sem dispensas. Falta de resposta não vira zero nesta média. Resultados com menos de 5 correções ficam protegidos, sem exibir quantidades de estudantes ou percentuais.</p>
      <p>As avaliações podem ter questões diferentes. Não compare estas médias como um ranking de turmas, professores ou escolas. Elas não são uma medida de proficiência.</p>
      <p>Use esta consulta para combinar com o professor a revisão das dificuldades e o apoio necessário. Respostas individuais, nomes de estudantes e anotações docentes não são exibidos. Não há alteração ou exportação de dados neste ambiente.</p>
    </div></details>
    {resource.status === 'ready' && selected && skills?.url === url && <SchoolCoordinationSkills key={`${identity}:${url}:${skills.classId}`}
      identity={identity} schoolId={selected} classId={skills.classId} onClose={() => setSkills(null)} />}
    {resource.status === 'ready' && selected && support?.url === url && <SchoolCoordinationSupport key={`${identity}:${url}:${support.classId}`}
      identity={identity} schoolId={selected} classId={support.classId} onClose={() => setSupport(null)} />}
  </div>;
}
function Filters({ selected, year, search, classSearch, update }) {
  const [value, setValue] = useState(selected ? classSearch : search);
  const [yearValue, setYearValue] = useState(year);
  return <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); update(selected ? { turma: value.trim(), ano: yearValue, pagina: null } : { busca: value.trim(), pagina: null }); }}>
    <label className="min-w-0 basis-full text-sm font-semibold sm:flex-1 sm:basis-0">{selected ? 'Buscar turma' : 'Buscar escola ou município'}<input className="input mt-1" type="search" maxLength={100} value={value} onChange={event => setValue(event.target.value)} placeholder={selected ? 'Nome da turma ou ano escolar' : 'Digite parte do nome'} /></label>
    {selected && <label className="min-w-0 flex-1 text-sm font-semibold sm:max-w-48">Ano letivo (opcional)<input className="input mt-1" type="number" min={2000} max={2100} step={1} value={yearValue} onChange={event => setYearValue(event.target.value)} placeholder="Todos os anos" /></label>}
    <button className={button} type="submit">{selected ? 'Filtrar' : 'Buscar'}</button>
    {(selected ? year || classSearch : search) && <button className={button} type="button" onClick={() => update(selected ? { turma: null, ano: null, pagina: null } : { busca: null, pagina: null })}>Limpar filtros</button>}
  </form>;
}
