import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { networkResults } from '../services/institutionalNetworkView.mjs';
import InstitutionalManagementPanel from './InstitutionalManagementPanel';

const panel = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const muted = 'text-sm leading-5 text-slate-600 dark:text-slate-300';
const button = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60 dark:text-cyan-200 dark:hover:bg-white/5';
const field = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-white/20 dark:bg-[#111E31] dark:text-white';
const summaryClass = 'min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold';

export default function InstitutionalNetwork({ model, refreshing, error, refresh, operationalPilot }) {
  const { isEnabled } = useFeatureFlags();
  const [query, setQuery] = useState('');
  const [municipalityId, setMunicipalityId] = useState('');
  const [limit, setLimit] = useState(10);
  const [managementOpened, setManagementOpened] = useState(false);
  const management = useRef(null);
  const search = useRef(null);
  const admin = model.mode === 'admin';
  const municipalityOptions = useMemo(() => networkResults(model.municipalities), [model.municipalities]);
  const canFilterMunicipalities = model.municipalities.length > 1 || Boolean(municipalityId);
  const results = useMemo(() => networkResults(model.municipalities, query, municipalityId), [model.municipalities, query, municipalityId]);
  const schoolCount = results.reduce((total, item) => total + item.visibleSchools.length, 0);
  const filtered = Boolean(query.trim() || municipalityId);
  const clear = () => { setQuery(''); setMunicipalityId(''); setLimit(10); search.current?.focus(); };
  const scrollManagement = useCallback(() => {
    if (management.current?.open && management.current.contains(document.activeElement)) {
      management.current.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, []);
  const openManagement = () => {
    setManagementOpened(true); management.current.open = true;
    management.current.querySelector('summary').focus();
    requestAnimationFrame(scrollManagement);
  };
  return <div data-institutional-network style={{ maxWidth: '64rem' }} className="mx-auto space-y-3 px-3 py-3 text-slate-900 dark:text-slate-100 sm:px-5">
    <header className="flex flex-wrap items-center justify-between gap-x-3">
      <h1 className="text-xl font-bold tracking-tight">{admin ? 'Escolas e rede' : 'Minha rede'}</h1>
      <button type="button" className={button} onClick={refresh} disabled={refreshing}>{refreshing ? 'Atualizando…' : 'Atualizar'}</button>
    </header>
    <p className={muted}>{admin ? 'Consulte os municípios e as escolas cadastradas.' : 'Veja apenas as escolas sob sua responsabilidade.'}</p>
    {isEnabled('institutions.school_coordination') && <Link className={button} to="/acompanhamento-escolar">Acompanhar turmas da escola</Link>}
    {error && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-100">{error} Os dados abaixo são da última consulta e podem estar desatualizados.</p>}
    {refreshing && <p role="status" className={muted}>Conferindo os dados. A lista atual continua disponível.</p>}
    <div className="flex flex-wrap items-center gap-x-2">
      <details className="min-w-0 flex-1" data-network-totals>
        <summary aria-label="Resumo da rede" className={`${summaryClass} rounded-xl bg-slate-100 dark:bg-white/5`}>Resumo</summary>
        <div className="space-y-3 px-1 py-3">
          <Counts items={[[admin ? 'Municípios ativos' : 'Municípios visíveis', model.summary.activeMunicipalities], [admin ? 'Escolas ativas' : 'Escolas visíveis', model.summary.activeSchools], ['Profissionais vinculados', model.summary.linkedProfessionals], ['Turmas confirmadas', model.summary.verifiedClasses]]} />
          <p className={muted}>Totais da rede que você pode consultar, sem aplicar a busca abaixo. Uma pessoa com vários vínculos conta uma vez no total de profissionais.</p>
          {admin && <><details><summary className={summaryClass}>Vínculos por função</summary><Counts items={[[ 'Gestão municipal', model.summary.roleCoverage.municipalManagers], ['Gestão escolar', model.summary.roleCoverage.schoolManagers], ['Coordenação', model.summary.roleCoverage.schoolCoordinators], ['Professor(a)', model.summary.roleCoverage.teachers]]} /><p className={`px-1 py-2 ${muted}`}>Contamos os vínculos ativos, não pessoas diferentes. A mesma pessoa pode ter mais de uma função.</p></details><p className={muted}>{model.summary.pendingClasses} turma(s) sem escola vinculada · {model.summary.linkedClasses} com escola indicada, ainda a confirmar. Elas não entram nas turmas confirmadas.</p></>}
        </div>
      </details>
      {operationalPilot && <button type="button" className={button} onClick={openManagement}>{admin ? 'Cadastros e turmas' : 'Minhas confirmações'}</button>}
    </div>
    <section aria-label="Consulta de municípios e escolas" className="space-y-3">
      <div className={canFilterMunicipalities ? 'grid gap-2 sm:grid-cols-2' : 'grid gap-2'}>
        <div><label htmlFor="network-search" className="sr-only">Buscar município ou escola</label><input ref={search} id="network-search" className={field} type="search" maxLength={180} placeholder="Buscar município ou escola" value={query} onChange={event => { setQuery(event.target.value); setLimit(10); }} /></div>
        {canFilterMunicipalities && <div><label htmlFor="network-municipality" className="sr-only">Filtrar município</label><select id="network-municipality" className={field} value={municipalityId} onChange={event => { setMunicipalityId(event.target.value); setLimit(10); }}><option value="">Todos os municípios visíveis</option>{municipalityOptions.map(item => <option key={item.publicId} value={item.publicId}>{item.name}</option>)}{municipalityId && !model.municipalities.some(item => item.publicId === municipalityId) && <option value={municipalityId}>Município não disponível na consulta atual</option>}</select></div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <p className={muted} role="status">{results.length} município(s) · {schoolCount} escola(s){filtered ? ' na busca' : ' na lista'}</p>
        {filtered && <button type="button" className={button} onClick={clear}>Limpar busca</button>}
      </div>
      {results.length ? <ul className="space-y-3">{results.slice(0, limit).map(item => <Municipality key={`${item.publicId}:${query}:${municipalityId}`} item={item} />)}</ul> : <div className={`${panel} p-4`}><h2 className="font-semibold">{filtered ? 'Nenhum município ou escola encontrado' : 'Nenhum município disponível nesta consulta'}</h2><p className={`mt-1 ${muted}`}>{filtered ? 'Tente parte do nome ou limpe a busca.' : admin ? operationalPilot ? 'Use Cadastros e turmas para começar pelo município.' : 'Os cadastros precisam ser liberados para sua conta pela administração do sistema.' : 'Peça à administração para conferir seus vínculos com a rede.'}</p></div>}
      {results.length > limit && <button type="button" className={`${button} w-full border border-slate-300 dark:border-white/20`} onClick={() => setLimit(value => value + 10)}>Mostrar mais municípios ({results.length - limit} restantes)</button>}
    </section>
    <details className={panel}>
      <summary className={summaryClass}>Como ler estes dados</summary>
      <div className={`space-y-2 px-3 pb-3 ${muted}`}>
        <p>As listas mostram municípios e escolas ativos. Os totais de cada escola consideram seus vínculos ativos e as turmas com escola confirmada.</p>
        <p>Uma pessoa pode trabalhar em mais de uma escola. Por isso, somar os profissionais das escolas pode dar um número maior que o total do município.</p>
        <p>“Vínculos docentes” e “Gestão e coordenação” contam funções registradas, não necessariamente pessoas diferentes. Não são medidas de desempenho profissional.</p>
        {!admin && <p>{model.scopeLevel === 'municipality' ? 'Seu vínculo permite consultar os municípios atribuídos à sua gestão.' : model.scopeLevel === 'school' ? 'Você vê somente as escolas atribuídas à sua gestão ou coordenação, não todas as escolas do município.' : 'Sua conta reúne permissões de município e de escola. Cada lista respeita esses vínculos.'}</p>}
        <p>Esta consulta mostra quantidades, não nomes de profissionais ou estudantes. Nenhum vínculo é escolhido pelo nome ou pelo e-mail da pessoa.</p>
        <p>{operationalPilot ? 'Cadastros e confirmações ficam no ambiente de testes, com registro das operações. As turmas preparadas pela administração precisam ser conferidas pelo professor responsável.' : 'Somente consulta: os cadastros não estão liberados nesta conta.'}</p>
      </div>
    </details>
    {operationalPilot && <details ref={management} className={`${panel} scroll-mt-28`} onToggle={event => { if (event.currentTarget.open) setManagementOpened(true); }} data-network-management>
      <summary className={summaryClass}>{admin ? 'Cadastros e turmas' : 'Minhas confirmações'}</summary>
      <div className="p-3 pt-0">{managementOpened && <InstitutionalManagementPanel compact={!admin} onChanged={refresh} onReady={scrollManagement} />}<p className={`mt-3 ${muted}`}>Ambiente de testes. Recolher esta seção mantém o preenchimento enquanto você permanece nesta página.</p></div>
    </details>}
  </div>;
}

function Municipality({ item }) {
  const [limit, setLimit] = useState(5);
  return <li className={`${panel} overflow-hidden`}>
    <header className="border-b border-slate-200 px-3 py-3 dark:border-white/10"><h2 className="font-bold" data-network-municipality>{item.name}</h2><p className={`mt-1 ${muted}`}>{item.visibleSchools.length} escola(s) nesta lista · {item.professionalCount} profissional(is) {item.accessLevel === 'schools' ? 'nas escolas autorizadas' : 'no município'}</p>{item.roleLabels?.length > 0 && <p className={`mt-1 ${muted}`}>{item.roleLabels.join(' · ')}</p>}</header>
    {item.visibleSchools.length ? <ul className="divide-y divide-slate-200 dark:divide-white/10">{item.visibleSchools.slice(0, limit).map(school => <li key={school.publicId} className="px-3 py-3"><h3 className="text-sm font-semibold">{school.name}</h3><p className={`mt-1 ${muted}`}>{school.professionalCount} profissional(is) · {school.verifiedClassCount} turma(s) confirmada(s)</p><details className="mt-1"><summary className={`${summaryClass} -ml-3 text-blue-700 dark:text-cyan-200`}>Vínculos por função</summary><Counts items={[[ 'Vínculos docentes', school.teacherCount], ['Gestão e coordenação', school.leadershipCount]]} /></details></li>)}</ul> : <p className={`px-3 py-3 ${muted}`}>Nenhuma escola disponível neste município.</p>}
    {item.visibleSchools.length > limit && <button type="button" className={`${button} w-full border-t border-slate-200 dark:border-white/10`} onClick={() => setLimit(value => value + 5)}>Mostrar mais escolas ({item.visibleSchools.length - limit} restantes)</button>}
  </li>;
}

function Counts({ items }) { return <dl className="grid grid-cols-2 gap-2">{items.map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-white/5"><dt className="text-xs leading-5 text-slate-600 dark:text-slate-300">{label}</dt><dd className="text-lg font-bold">{value}</dd></div>)}</dl>; }
