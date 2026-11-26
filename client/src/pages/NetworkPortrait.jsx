import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Building2, Copy, ExternalLink, Info, Search } from 'lucide-react';
import api from '../services/api';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { useAuth } from '../contexts/AuthContext';
import { portraitStages, indicatorValue, comparisonText, absenceText, portraitError, parsePortraitPublication, parsePortraitSearch, parsePortraitResult } from '../services/networkPortraitView.mjs';
import { readPortraitQuery, portraitSearchParams, portraitShareUrl } from '../services/networkPortraitQuery.mjs';

export default function NetworkPortrait() {
  const { user } = useAuth();
  return <PortraitConsultation key={user?.id} />;
}

function PortraitConsultation() {
  const { isEnabled } = useFeatureFlags();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const filters = readPortraitQuery(params), { ibgeCode, stage, year } = filters;
  const [reload, setReload] = useState(0), [bootstrap, setBootstrap] = useState(null);
  const [query, setQuery] = useState(''), [selection, setSelection] = useState(null);
  const searchInput = useRef(null), municipalityLabel = useRef(null), pendingFocus = useRef(null);
  const [search, setSearch] = useState(null), [snapshot, setSnapshot] = useState(null);
  const key = filters.valid && ibgeCode ? `${ibgeCode}:${stage}:${year}:${reload}:${location.key}` : null;
  const current = snapshot?.key === key ? snapshot : null;
  const result = current?.data;
  const selected = ibgeCode ? result?.municipality || (selection?.ibgeCode === ibgeCode ? selection : { ibgeCode, name: `IBGE ${ibgeCode}`, uf: '' }) : null;
  const searchKey = `${query}:${reload}:${location.key}`;
  const found = search?.key === searchKey ? search : null;
  function changeFilters(patch) { setParams(portraitSearchParams({ ...filters, ...patch })); }
  function choose(place) {
    pendingFocus.current = 'municipality';
    setSelection(place); changeFilters({ ibgeCode: place.ibgeCode });
  }
  function changeMunicipality() {
    pendingFocus.current = 'search';
    setSelection(null); setQuery(''); setSearch(null); changeFilters({ ibgeCode: '' });
  }
  // Router navigation may commit after requestAnimationFrame. Focus only after the target is mounted.
  useEffect(() => {
    const target = pendingFocus.current === 'search' ? searchInput.current
      : pendingFocus.current === 'municipality' ? municipalityLabel.current : null;
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null; }
  }, [ibgeCode, location.key, bootstrap]);
  useEffect(() => { if (result?.municipality) setSelection(result.municipality); }, [result]);
  useEffect(() => {
    const controller = new AbortController();
    setBootstrap(null);
    if (!filters.valid) return () => controller.abort();
    api.get('/municipal-indicators', { signal: controller.signal, timeout: 15000 })
      .then(({ data }) => { if (!controller.signal.aborted) setBootstrap({ data: parsePortraitPublication(data) }); })
      .catch(error => { if (!controller.signal.aborted) setBootstrap({ error: portraitError(error.response?.status, error.response?.data?.code || error.code) }); });
    return () => controller.abort();
  }, [reload, filters.valid]);
  useEffect(() => {
    if (!filters.valid || !bootstrap?.data?.available || ibgeCode || query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => api.get('/municipal-indicators/municipalities', { params: { q: query.trim() }, signal: controller.signal, timeout: 15000 })
      .then(({ data }) => { if (!controller.signal.aborted) setSearch({ key: searchKey, data: parsePortraitSearch(data) }); })
      .catch(error => { if (!controller.signal.aborted) setSearch({ key: searchKey, error: portraitError(error.response?.status, error.response?.data?.code || error.code) }); }), 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, ibgeCode, searchKey, bootstrap, filters.valid]);
  useEffect(() => {
    if (!key || !bootstrap?.data?.available) return;
    const controller = new AbortController();
    api.get(`/municipal-indicators/municipalities/${ibgeCode}`, { params: { stage, year }, signal: controller.signal, timeout: 15000 })
      .then(({ data }) => { if (!controller.signal.aborted) setSnapshot({ key, data: parsePortraitResult(data, { ibgeCode, stage, year }) }); })
      .catch(error => { if (!controller.signal.aborted) setSnapshot({ key, error: portraitError(error.response?.status, error.response?.data?.code || error.code) }); });
    return () => controller.abort();
  }, [key, bootstrap]);
  const error = bootstrap?.error || current?.error || (!selected && found?.error);
  return <section data-network-portrait className="mx-auto max-w-6xl space-y-4 bg-slate-50 px-3 py-4 text-slate-800 dark:bg-transparent dark:text-slate-100 sm:px-6">
    <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1">
      <div><p className="mb-1 text-xs font-semibold text-teal-700 dark:text-cyan-300">DADOS PÚBLICOS · INEP</p>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Retrato da rede</h1></div>
      <Link to={isEnabled('institutions.read_model') ? '/instituicoes' : '/'} aria-label={isEnabled('institutions.read_model') ? 'Voltar para escolas e rede' : 'Voltar para o início'} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-teal-800 dark:text-cyan-200"><ArrowLeft size={16} />Voltar</Link>
      <p className="col-span-2 text-sm text-slate-600 dark:text-slate-300">Conheça os indicadores da rede municipal e leve perguntas para a equipe.</p>
    </header>
    {!filters.valid && <div role="alert" className="card space-y-3 p-4"><h2 className="font-bold">Não conseguimos abrir os filtros deste link</h2><p className="text-sm">Confira o endereço recebido ou escolha o município novamente. Nenhum resultado foi substituído por outro recorte.</p><button type="button" className="btn-outline" onClick={() => { setQuery(''); setSearch(null); setParams(new URLSearchParams()); }}>Escolher município</button></div>}
    {filters.valid && <>
    {!bootstrap && <p role="status" className="card p-4 text-sm">Consultando a base de indicadores…</p>}
    {error && <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100">
      <p>{error}</p><button type="button" className="mt-1 min-h-11 font-bold underline" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></div>}
    {bootstrap?.data && !bootstrap.data.available && <div className="card space-y-2 p-5"><h2 className="font-bold">A base ainda está sendo preparada</h2>
      <p className="text-sm">Os dados só aparecem depois da conferência da fonte e da publicação da base. Nenhum resultado de exemplo será apresentado como oficial.</p>
      <button className="btn-outline" onClick={() => setReload(n => n + 1)}>Conferir novamente</button></div>}
    {bootstrap?.data?.available && <>
      <div className="card p-4">
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3 md:grid-cols-[1.3fr_1fr_0.65fr]">
          <div className="col-span-2 min-w-0 md:col-span-1">
            {selected ? <div><p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Município · rede municipal</p>
              <div className="flex min-h-11 items-center justify-between gap-2"><p ref={municipalityLabel} tabIndex={-1} className="min-w-0 font-bold">{selected.name}{selected.uf ? ` · ${selected.uf}` : ''}</p><button onClick={changeMunicipality} className="min-h-11 shrink-0 px-2 text-sm font-semibold text-teal-800 underline dark:text-cyan-200">Trocar</button></div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Código IBGE {selected.ibgeCode}</p></div>
              : <label className="block text-sm font-semibold">Município<span className="relative mt-1 block"><Search aria-hidden="true" className="absolute left-3 top-3 text-slate-400" size={18} />
                <input ref={searchInput} className="input min-h-11 pl-10" value={query} maxLength={80} autoComplete="off" placeholder="Digite o nome ou código IBGE" onChange={e => setQuery(e.target.value)} aria-describedby="municipality-search-help" /></span></label>}
          </div>
          <div className="min-w-0"><label htmlFor="portrait-stage" className="block text-sm font-semibold">Etapa escolar</label><select id="portrait-stage" className="select mt-1 min-h-11" value={stage} onChange={e => changeFilters({ stage: e.target.value })}><option value="elementary_initial">1º ao 5º ano</option><option value="elementary_final">6º ao 9º ano</option></select></div>
          <div className="min-w-0"><label htmlFor="portrait-year" className="block text-sm font-semibold">Ano dos dados</label><select id="portrait-year" className="select mt-1 min-h-11" value={year} onChange={e => changeFilters({ year: e.target.value })}><option>2025</option><option>2023</option></select></div>
        </div>
        {!selected && <div className="mt-2 text-sm"><p id="municipality-search-help" className="text-xs text-slate-500 dark:text-slate-400">Digite ao menos 2 caracteres. Esta consulta não altera os cadastros da sua instituição.</p>
          {query.trim().length >= 2 && !found && <p role="status" className="mt-3">Buscando municípios…</p>}
          {found?.data && !found.data.available && <p role="status" className="mt-3">A base está indisponível neste momento. Use “Tentar novamente” para conferir a publicação.</p>}
          {found?.data && !found.data.available && <button type="button" className="btn-outline mt-2" onClick={() => setReload(n => n + 1)}>Tentar novamente</button>}
          {found?.data?.available && found.data.municipalities.length === 0 && <p role="status" className="mt-3">Nenhum município encontrado. Tente o nome sem abreviação ou o código IBGE.</p>}
          {found?.data?.municipalities.length > 0 && <div role="group" aria-label="Municípios encontrados" className="mt-3 max-h-64 overflow-auto rounded-xl border border-slate-200 dark:border-slate-600">
            {found.data.municipalities.map(place => <button key={place.ibgeCode} aria-label={`${place.name}, ${place.uf}, código IBGE ${place.ibgeCode}`} onClick={() => choose(place)} className="flex min-h-12 w-full items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 text-left last:border-0 hover:bg-teal-50 focus-visible:bg-teal-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:focus-visible:bg-slate-700">
              <span><strong>{place.name} · {place.uf}</strong><span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{place.ibgeCode}</span></span><ArrowRight aria-hidden="true" size={16} /></button>)}</div>}
        </div>}
      </div>
      {!selected && <div className="flex gap-3 rounded-xl border border-teal-200 bg-teal-50/70 p-4 dark:border-cyan-400/20 dark:bg-cyan-950/20"><Building2 className="shrink-0 text-teal-700 dark:text-cyan-300" size={24} /><div><h2 className="font-bold">Comece pelo município</h2><p className="mt-1 text-sm">Você verá o Ideb e a comparação entre 2023 e 2025. O índice reúne aprovação escolar e desempenho no Saeb; não mostra, sozinho, a causa de uma dificuldade.</p></div></div>}
      {selected && !current && <p role="status" className="card p-5 text-sm">Consultando o resultado de {selected.name}…</p>}
      {result && !result.available && <div role="status" className="card space-y-2 p-4 text-sm"><p>A base não está disponível neste momento.</p><button type="button" className="btn-outline" onClick={() => setReload(n => n + 1)}>Conferir novamente</button></div>}
      {result?.available && <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <article className="card overflow-hidden" aria-label="Resultado do Ideb">
          <div className="border-b border-slate-200 bg-teal-50/70 p-4 dark:border-slate-700 dark:bg-cyan-950/20 sm:p-5">
            <div className="flex items-center justify-between gap-2"><h2 className="font-bold">Ideb · {result.year}</h2><span className="text-xs text-slate-500 dark:text-slate-400">Escala de 0 a 10</span></div>
            <p className={`mt-2 font-bold tracking-tight ${result.current?.status === 'published' ? 'text-5xl text-teal-800 dark:text-cyan-200' : 'text-xl'}`}>{indicatorValue(result.current)}</p>
            <p className="mt-2 text-sm">{result.current?.status === 'published' ? comparisonText(result) : absenceText(result.current)}</p>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{result.municipality?.name} · rede municipal · {portraitStages[result.stage]}</p>
          </div>
          <div className="p-4 sm:p-5"><table className="w-full text-left text-sm"><caption className="pb-2 text-left font-bold">Compare os anos no mesmo recorte</caption>
            <thead><tr className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"><th scope="col" className="py-2">Ano dos dados</th><th scope="col" className="py-2 text-right">Ideb</th></tr></thead>
            <tbody>{result.series.map(row => <tr key={row.year} className="border-b border-slate-100 last:border-0 dark:border-slate-700/60"><th scope="row" className="py-3 font-medium">{row.year}</th><td className="py-3 text-right font-semibold">{indicatorValue(row)}</td></tr>)}</tbody></table>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">A diferença é em pontos do Ideb, não em porcentagem. Dados ausentes não entram na comparação.</p></div>
          <PortraitShare key={`${key}:${result.batchId}`} result={result} />
        </article>
        <aside className="space-y-3" aria-label="Ajuda para analisar os indicadores">
          <div className="card p-4 sm:p-5"><h2 className="flex items-center gap-2 font-bold"><Info size={18} className="text-teal-700 dark:text-cyan-300" />O que vale conversar com a equipe?</h2>
            <ul className="mt-3 space-y-2 pl-4 text-sm leading-relaxed"><li className="list-disc">O que mudou na aprendizagem e na aprovação nesse período?</li><li className="list-disc">Quais dificuldades aparecem também nas atividades das turmas?</li><li className="list-disc">Que outras informações precisamos reunir antes de planejar uma ação?</li></ul>
            <p className="mt-3 rounded-lg bg-slate-100 p-3 text-xs leading-relaxed text-slate-600 dark:bg-slate-700/40 dark:text-slate-300">Este é um dado da rede, não uma nota do professor. As avaliações do LabMathic não são Saeb e não foram usadas para calcular este índice.</p></div>
          <details className="card p-4"><summary className="min-h-11 cursor-pointer font-semibold">Fonte e cuidados na leitura</summary><div className="mt-3 space-y-3 text-sm leading-relaxed">
            <p>Resultados oficiais do Inep, conferidos com os códigos municipais do IBGE. Esta entrega apresenta somente o Ideb de 2023 e 2025. Não mistura redes estaduais, privadas ou resultados de escolas isoladas.</p>
            <p>Antes de interpretar uma mudança, considere também a participação no Saeb e possíveis alterações no território ou na composição da rede. O código IBGE, sozinho, não comprova que essas condições permaneceram iguais.</p>
            <p>Coleta: {new Date(result.manifest.retrievedAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}. A consulta usa uma base local conferida; não busca atualizações no Inep a cada acesso.</p>
            <a className="inline-flex min-h-11 items-center gap-2 font-semibold text-teal-800 underline dark:text-cyan-200" href={result.manifest.sourcePage} target="_blank" rel="noopener noreferrer">Ver resultados e notas no Inep<ExternalLink size={14} /></a>
            <a className="flex min-h-11 items-center gap-2 text-teal-800 underline dark:text-cyan-200" href={result.manifest.sources.find(s => s.stage === result.stage).url} target="_blank" rel="noopener noreferrer">Baixar a planilha oficial desta etapa<ExternalLink size={14} /></a>
            <p className="break-all text-xs text-slate-500 dark:text-slate-400">Versão da base: {result.batchId.slice(0, 12)}</p></div></details>
        </aside>
      </div>}
    </>}
    </>}
  </section>;
}

function PortraitShare({ result }) {
  const [status, setStatus] = useState('idle');
  const alive = useRef(true), lock = useRef(false), manual = useRef(null);
  const link = portraitShareUrl(window.location.origin, { ibgeCode: result.municipality.ibgeCode, stage: result.stage, year: result.year });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (status === 'manual') { manual.current?.focus(); manual.current?.select(); } }, [status]);
  async function copy() {
    if (lock.current) return;
    lock.current = true; setStatus('copying');
    try { await navigator.clipboard.writeText(link); if (alive.current) setStatus('copied'); }
    catch { if (alive.current) setStatus('manual'); }
    finally { lock.current = false; }
  }
  return <div className="space-y-2 border-t border-slate-200 p-4 dark:border-slate-700 sm:p-5">
    <button type="button" className="btn-outline" disabled={status === 'copying'} onClick={copy}><Copy aria-hidden="true" size={16} />{status === 'copying' ? 'Copiando…' : 'Copiar link desta consulta'}</button>
    <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">O link guarda município, etapa e ano. Quem receber precisa entrar com uma conta com acesso a esta área. Ele abre a base publicada no momento, não uma cópia fixa dos resultados.</p>
    {status === 'copied' && <p role="status" className="text-sm text-teal-800 dark:text-cyan-200">Link copiado. Você pode enviá-lo à equipe.</p>}
    {status === 'manual' && <div className="space-y-2"><p role="status" className="text-sm">A cópia automática não foi permitida. Selecione e copie o endereço abaixo.</p><label className="block text-sm font-semibold">Link desta consulta<input ref={manual} className="input mt-1 w-full min-w-0 text-sm" readOnly value={link} onFocus={e => e.target.select()} /></label></div>}
  </div>;
}
