import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useDemoResource from '../hooks/useDemoResource';
import { DemoHeader, DemoSelect, DemoReadState, DemoPrintState, demoPanel } from '../components/DemoWorkspace';
import { demoFilters, demoFilterKeys, demoQuery, parseReviewCatalog, parseReviewDetail } from '../services/demoView.mjs';

export default function QuestionBankCatalogLab() {
  const [params, setParams] = useSearchParams();
  const filters = demoFilters(params), query = demoQuery(filters);
  const selectedId = params.get('item') || '';
  const [search, setSearch] = useState(filters.search), [options, setOptions] = useState(null);
  const heading = useRef(null), rows = useRef({}), returnFocus = useRef(null);
  const result = useDemoResource('/question-bank/catalog-preview/catalog' + (query ? '?' + query : ''), parseReviewCatalog);
  useEffect(() => setSearch(filters.search), [filters.search]);
  useEffect(() => { if (result.data) setOptions(result.data.filters); }, [result.data]);
  const selected = result.data?.items.find(i => i.id === selectedId);
  const parse = useCallback(data => parseReviewDetail(data, selectedId), [selectedId]);
  const detail = useDemoResource(selected ? '/question-bank/catalog-preview/items/' + encodeURIComponent(selectedId) : null, parse);
  useEffect(() => {
    if (detail.data) { heading.current?.focus({ preventScroll: true }); heading.current?.parentElement?.scrollIntoView({ block: 'start' }); }
  }, [detail.data]);
  useEffect(() => {
    if (!selectedId && returnFocus.current) {
      rows.current[returnFocus.current]?.focus();
      returnFocus.current = null;
    }
  }, [selectedId, result.data]);
  function change(values) {
    const next = new URLSearchParams(params);
    next.delete('item');
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    setParams(next);
  }
  function clear() { change(Object.fromEntries(demoFilterKeys.map(k => [k, '']))); }
  function select(value) { const next = new URLSearchParams(params); next.set('item', value); setParams(next); }
  function back() {
    returnFocus.current = selectedId;
    change({});
  }
  const count = Object.values(filters).filter(Boolean).length;
  return <div data-demo-review className="catalog-preview-page bank-form demo-workspace mx-auto max-w-6xl space-y-3 px-3 pb-8">
    <div className="catalog-preview-screen-only space-y-3">
      <DemoHeader title="Revisão de questões" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label="Exemplos para revisão" className={selectedId ? 'hidden min-w-0 space-y-3 lg:block' : 'min-w-0 space-y-3 lg:col-span-2'}>
          <form className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2" onSubmit={e => { e.preventDefault(); change({ search: search.trim() }); }}>
            <label className="text-sm font-semibold">Buscar exemplo<input type="search" className="input mt-1 w-full" maxLength={80} value={search} onChange={e => setSearch(e.target.value)} placeholder="Código, habilidade ou tema" /></label>
            <button type="submit" className="btn-outline">Buscar</button>
          </form>
          <details><summary className="cursor-pointer text-sm font-semibold">Filtros{count ? ' · ' + count + ' ativos' : ''}</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <ReviewFilter label="Formato" field="interactionType" filters={filters} options={options?.interactionTypes} change={change} />
              <ReviewFilter label="Ano escolar" field="grade" filters={filters} options={options?.grades.map(v => ({ value: v, label: v }))} change={change} />
              <ReviewFilter label="Unidade temática" field="unit" filters={filters} options={options?.units.map(v => ({ value: v, label: v }))} change={change} />
              <ReviewFilter label="Situação da revisão" field="reviewStatus" filters={filters} options={options?.reviewStatuses} change={change} />
              <ReviewFilter label="Autoria" field="source" filters={filters} options={options?.sources} change={change} />
              {[['hasCommentedSolution', 'Com resolução comentada'], ['printReady', 'Pronto para impressão'], ['diagnosticCompatible', 'Compatível com diagnóstico']].map(([field, label]) => <ReviewFilter key={field} label={label} field={field} filters={filters} options={[{ value: 'true', label: 'Sim' }, { value: 'false', label: 'Não' }]} change={change} />)}
            </div>
          </details>
          {count > 0 && <button type="button" className="btn-outline" onClick={clear}>Limpar filtros</button>}
          <DemoReadState resource={result} />
          {result.data && <>
            <p role="status" aria-live="polite" className="text-sm">{result.data.total} exemplos encontrados</p>
            {result.data.items.length ? <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">
              {result.data.items.map(item => <li key={item.id}>
                <button ref={el => { rows.current[item.id] = el; }} data-demo-review-row={item.id} type="button" className="w-full p-3 text-left hover:bg-cyan-50 dark:hover:bg-white/5 focus-visible:outline-offset-[-3px]" onClick={() => select(item.id)} aria-label={'Ver ficha: ' + item.title}>
                  <h2 className="font-bold">{item.title}</h2>
                  <p className="mt-1 text-sm">{item.code} · {item.grade} · {item.skillCode}</p>
                  <p className="mt-1 text-sm">{item.interactionLabel} · {item.reviewStatusLabel}</p>
                  <span className="mt-2 block text-sm font-semibold text-cyan-700 dark:text-cyan-300">Ver ficha de revisão →</span>
                </button>
              </li>)}
            </ul> : <div className={demoPanel}><h2 className="font-bold">{count ? 'Nenhum exemplo nestes filtros' : 'Nenhum exemplo disponível'}</h2><p className="mt-1 text-sm">{count ? 'Tente outra busca ou limpe os filtros.' : 'Tente novamente mais tarde.'}</p></div>}
            <details><summary className="cursor-pointer text-sm font-semibold">Resumo da revisão</summary><p className="text-sm">{result.data.summary.ready} prontos · {result.data.summary.inReview} em revisão · {result.data.summary.needsAttention} precisam de ajustes. Sem nota automática.</p></details>
          </>}
        </section>
        {selectedId && <section aria-label="Ficha de revisão" className="min-w-0 scroll-mt-28 space-y-3">
          <button type="button" className="btn-outline" onClick={back}>Voltar aos exemplos</button>
          {!result.data ? <DemoReadState resource={result} /> : !selected ? <p role="alert">Este item não está nos resultados atuais. Volte aos exemplos para escolher outro.</p> : <DemoReadState resource={detail} />}
          {selected && detail.data && <>
            <h2 ref={heading} tabIndex={-1} className="text-xl font-bold outline-none">{detail.data.item.title}</h2>
            <ItemDossier item={detail.data.item} />
          </>}
          <button type="button" className="btn-outline" disabled={!selected || !detail.data} onClick={() => window.print()}>Imprimir esta ficha</button>
        </section>}
      </div>
    </div>
    {selected && detail.data ? <PrintDossier item={detail.data.item} /> : <DemoPrintState className="catalog-preview-print-root" />}
  </div>;
}

function ReviewFilter({ label, field, filters, options = [], change }) {
  return <DemoSelect label={label} value={filters[field]} onChange={value => change({ [field]: value })} options={[{ value: '', label: 'Todos' }, ...options]} />;
}

function ItemDossier({ item }) {
  return <article className={demoPanel}>
    <p className="text-sm">{item.code} · {item.reviewStatusLabel}</p>
    <h3 className="mt-3 text-lg font-bold">{item.statement}</h3>
    {item.supportText && <p className="mt-2 text-sm">{item.supportText}</p>}
    {item.choices.length > 0 && <ul className="mt-3 grid gap-2 sm:grid-cols-2">{item.choices.map((choice, i) => <li key={i} className="rounded-lg border border-slate-200 p-2 text-sm dark:border-white/10">{choice}</li>)}</ul>}
    <section className="mt-3 rounded-xl bg-cyan-50 p-3 text-cyan-950 dark:bg-cyan-400/10 dark:text-cyan-100"><h3 className="font-bold">Comentário da revisão</h3><p className="mt-1 text-sm">{item.reviewerNote}</p></section>
    <details className="mt-2"><summary className="cursor-pointer text-sm font-semibold">Habilidade, autoria e uso</summary>
      <p className="mt-2 text-sm">{item.skillCode} · {item.grade} · {item.unit}</p><p className="mt-2 text-sm">{item.skillSummary}</p>
      <p className="mt-2 text-sm">{item.interactionLabel} · {item.correctionLabel} · {item.sourceLabel}</p>
      <ul className="mt-2 text-sm">{[['Resolução comentada', item.hasCommentedSolution], ['Pronto para impressão', item.printReady], ['Compatível com diagnóstico', item.diagnosticCompatible]].map(([label, ready]) => <li key={label}>{label}: {ready ? 'Sim' : 'Não'}</li>)}</ul>
    </details>
    <details className="mt-2"><summary className="cursor-pointer text-sm font-semibold">Conferir os critérios da revisão</summary>
      <p className="mt-1 text-sm">São exemplos de análise, sem nota automática. A decisão continua sendo do professor.</p>
      <ul className="mt-2 divide-y divide-slate-200 dark:divide-white/10">{item.criteria.map(c => <li key={c.id} className="py-3 text-sm"><h4 className="font-bold">{c.state === 'ready' ? 'Conferido' : 'Precisa de atenção'} · {c.label}</h4><p className="mt-1">{c.evidence}</p></li>)}</ul>
    </details>
  </article>;
}

function PrintDossier({ item }) {
  return (
    <section className="catalog-preview-print-root" aria-label="Ficha impressa de revisão pedagógica">
      <p className="text-xs font-bold uppercase">LabMathic · Exemplo de ficha de revisão</p>
      <h1 className="mt-2 text-2xl font-bold">{item.title}</h1>
      <p className="mt-1 text-sm">{item.code} · {item.interactionLabel} · {item.reviewStatusLabel}</p>
      <div className="mt-5 border border-black p-4"><strong>{item.skillCode} · {item.grade} · {item.unit}</strong><p className="mt-2">{item.skillSummary}</p><p className="mt-4"><strong>Questão:</strong> {item.statement}</p><p className="mt-2"><strong>Parecer:</strong> {item.reviewerNote}</p></div>
      <h2 className="mt-5 text-lg font-bold">Evidências por critério</h2>
      <div className="mt-3 space-y-3">{item.criteria.map((criterion) => <article key={criterion.id} className="border border-black p-3"><strong>{criterion.state === 'ready' ? 'PRONTO' : 'ATENÇÃO'} · {criterion.label}</strong><p className="mt-1 text-sm">{criterion.evidence}</p></article>)}</div>
      <p className="mt-8 border-t border-black pt-3 text-xs">Material demonstrativo. Sem dados reais, nota automática ou diagnóstico individual.</p>
    </section>
  );
}
