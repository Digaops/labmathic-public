import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp } from 'lucide-react';
import useDemoResource from '../hooks/useDemoResource';
import { DemoHeader, DemoSelect, DemoReadState, DemoPrintState, demoPanel } from '../components/DemoWorkspace';
import { parseFormatCatalog } from '../services/demoView.mjs';

const STRATEGY_LABELS = {
  exact: 'A resposta precisa estar completa para pontuar.',
  partial_with_penalty: 'Respostas certas somam pontos; escolhas erradas reduzem a pontuação.',
  numeric_exact: 'O valor informado é comparado com a resposta esperada.',
  per_blank: 'Cada espaço preenchido é considerado separadamente.',
  per_position: 'Cada posição correta conta na pontuação.',
  per_pair: 'Cada associação correta conta na pontuação.',
};

export default function TypedQuestionLab() {
  const [params, setParams] = useSearchParams();
  const result = useDemoResource('/question-bank/typed-preview/catalog', parseFormatCatalog);
  const examples = result.data?.examples || [];
  const selectedId = params.get('exemplo') || examples[0]?.id || '';
  const selected = examples.find(e => e.id === selectedId);
  function select(value) {
    const next = new URLSearchParams(params);
    if (value) next.set('exemplo', value); else next.delete('exemplo');
    setParams(next);
  }
  return <div data-demo-formats className="typed-lab-page bank-form demo-workspace mx-auto max-w-5xl space-y-3 px-3 pb-8">
    <div className="typed-lab-screen-only space-y-3">
      <DemoHeader title="Formatos de questões" />
      <DemoReadState resource={result} />
      {result.data && <>
        {examples.length ? <DemoSelect label="Escolha um formato" value={selectedId} onChange={select}
          options={[...(!selected ? [{ value: selectedId, label: 'Exemplo não encontrado' }] : []), ...examples.map(e => ({ value: e.id, label: e.typeLabel }))]} />
          : <p className={demoPanel}>Nenhum exemplo disponível neste momento.</p>}
        {!selected && examples.length > 0 && <div role="alert"><p>Este exemplo não está no catálogo.</p><button className="btn-outline mt-2" onClick={() => select('')}>Ver primeiro exemplo</button></div>}
        {examples.map(example => <div key={example.id} hidden={example.id !== selectedId}><ExampleWorkspace example={example} /></div>)}
        <p className="text-sm">Trocar de formato mantém suas marcações nesta aba. Ao sair ou recarregar, elas serão apagadas.</p>
        <button type="button" className="btn-outline" disabled={!examples.length} onClick={() => window.print()}>Imprimir os exemplos em branco</button>
      </>}
    </div>
    {result.data && examples.length ? <PrintCatalog examples={examples} /> : <DemoPrintState className="typed-lab-print-root" />}
  </div>;
}

function ExampleWorkspace({ example }) {
  const [resetKey, setResetKey] = useState(0);
  const definition = example.definition;
  return <article className={demoPanel}>
    <h2 className="text-lg font-bold">{definition.content.stem}</h2>
    {definition.content.supportText && <p className="mt-2 text-sm">{definition.content.supportText}</p>}
    <InteractivePreview key={resetKey} definition={definition} />
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" className="btn-outline" onClick={() => setResetKey(v => v + 1)}>Limpar respostas</button>
      <p className="text-sm">Suas respostas não são corrigidas nesta demonstração.</p>
    </div>
    <details className="mt-2"><summary className="cursor-pointer text-sm font-semibold">Objetivo e como responder</summary>
      <p className="mt-2 text-sm">{example.pedagogicalPurpose}</p>
      <p className="mt-2 text-sm">{definition.accessibility.instructions}</p>
      {definition.accessibility.keyboardInstructions && <p className="mt-2 text-sm">{definition.accessibility.keyboardInstructions}</p>}
      <p className="mt-2 text-sm">Regra prevista para este formato: {STRATEGY_LABELS[example.scoringStrategy]}</p>
      <p className="mt-2 text-sm">Os controles têm rótulos e podem ser usados pelo teclado. Isso não é uma certificação de acessibilidade.</p>
    </details>
  </article>;
}

function InteractivePreview({ definition }) {
  switch (definition.interactionType) {
    case 'single_choice': return <ChoicePreview definition={definition} multiple={false} />;
    case 'multiple_response': return <ChoicePreview definition={definition} multiple />;
    case 'true_false': return <TrueFalsePreview definition={definition} />;
    case 'numeric': return <NumericPreview definition={definition} />;
    case 'fill_blank': return <FillBlankPreview definition={definition} />;
    case 'ordering': return <OrderingPreview definition={definition} />;
    case 'matching': return <MatchingPreview definition={definition} />;
    default: return null;
  }
}

function ChoicePreview({ definition, multiple }) {
  const [selected, setSelected] = useState([]);
  function toggle(id) {
    setSelected((current) => multiple
      ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      : [id]);
  }
  return (
    <fieldset className="mt-5 space-y-2">
      <legend className="sr-only">{definition.accessibility.responseLabel}</legend>
      {definition.content.choices.map((choice) => (
        <label key={choice.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 transition hover:border-violet-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-100">
          <input
            type={multiple ? 'checkbox' : 'radio'}
            name="typed-preview-choice"
            checked={selected.includes(choice.id)}
            onChange={() => toggle(choice.id)}
            className="h-5 w-5 accent-violet-600"
          />
          {choice.text}
        </label>
      ))}
    </fieldset>
  );
}

function TrueFalsePreview({ definition }) {
  const [value, setValue] = useState('');
  return (
    <fieldset className="mt-5 grid gap-3 sm:grid-cols-2">
      <legend className="sr-only">{definition.accessibility.responseLabel}</legend>
      {[['true', 'Verdadeiro'], ['false', 'Falso']].map(([option, label]) => (
        <label key={option} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 font-bold text-neutral-800 hover:border-violet-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-100">
          <input type="radio" name="typed-preview-boolean" value={option} checked={value === option} onChange={(event) => setValue(event.target.value)} className="h-5 w-5 accent-violet-600" />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

function NumericPreview({ definition }) {
  const [value, setValue] = useState('');
  return (
    <div className="mt-5 max-w-sm">
      <label htmlFor="typed-preview-numeric" className="label">Valor numérico{definition.content.unit ? ` (${definition.content.unit})` : ''}</label>
      <div className="flex items-center gap-3">
        <input id="typed-preview-numeric" inputMode="decimal" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} className="input min-w-0 w-full text-lg font-bold" placeholder="Ex.: 12 ou 12,5" />
        {definition.content.unit && <span className="font-black text-neutral-500 dark:text-neutral-300">{definition.content.unit}</span>}
      </div>
    </div>
  );
}

function FillBlankPreview({ definition }) {
  const [answers, setAnswers] = useState({});
  const blanks = new Map(definition.content.blanks.map((blank) => [blank.id, blank]));
  const parts = definition.content.prompt.split(/(\{\{[a-z][a-z0-9_-]*\}\})/g);
  return (
    <div className="mt-5 rounded-2xl border border-neutral-200 bg-white p-4 text-base leading-[3.8rem] text-neutral-800 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-100">
      {parts.map((part, index) => {
        const match = part.match(/^\{\{([a-z][a-z0-9_-]*)\}\}$/);
        if (!match) return <span key={`${part}-${index}`}>{part}</span>;
        const blank = blanks.get(match[1]);
        return (
          <span key={blank.id} className="my-2 inline-flex w-full min-w-0 flex-col align-middle leading-tight sm:mx-1 sm:w-48">
            <label htmlFor={`typed-blank-${blank.id}`} className="mb-1 text-[10px] font-black uppercase tracking-wide text-neutral-500 dark:text-neutral-300">{blank.text}</label>
            <input id={`typed-blank-${blank.id}`} value={answers[blank.id] || ''} onChange={(event) => setAnswers((current) => ({ ...current, [blank.id]: event.target.value }))} className="input px-3 py-2" />
          </span>
        );
      })}
    </div>
  );
}

function OrderingPreview({ definition }) {
  const [items, setItems] = useState(definition.content.items);
  const [announcement, setAnnouncement] = useState('');
  const moved = useRef(null), rows = useRef({});
  useEffect(() => {
    if (moved.current) rows.current[moved.current]?.querySelector('button:not(:disabled)')?.focus();
    moved.current = null;
  }, [items]);
  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    moved.current = items[index].id;
    setAnnouncement(items[index].text + ' na posição ' + (target + 1));
    setItems((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  return (
    <><p role="status" className="sr-only">{announcement}</p><ol className="mt-5 space-y-2" aria-label={definition.accessibility.responseLabel}>
      {items.map((item, index) => (
        <li ref={el => { rows.current[item.id] = el; }} key={item.id} className="flex min-h-14 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-2 py-2 dark:border-white/10 dark:bg-white/[0.03]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-sm font-black text-violet-700 dark:bg-violet-400/15 dark:text-violet-200">{index + 1}</span>
          <span className="min-w-0 flex-1 font-bold text-neutral-800 dark:text-neutral-100">{item.text}</span>
          <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className="btn-icon btn-ghost" aria-label={`Mover ${item.text} para cima`}><ArrowUp size={17} /></button>
          <button type="button" onClick={() => move(index, 1)} disabled={index === items.length - 1} className="btn-icon btn-ghost" aria-label={`Mover ${item.text} para baixo`}><ArrowDown size={17} /></button>
        </li>
      ))}
    </ol></>
  );
}

function MatchingPreview({ definition }) {
  const [pairs, setPairs] = useState({});
  const selectedValues = new Set(Object.values(pairs).filter(Boolean));
  return (
    <div className="mt-5 space-y-3" role="group" aria-label={definition.accessibility.responseLabel}>
      {definition.content.leftItems.map((left) => (
        <div key={left.id} className="grid items-center gap-2 rounded-xl border border-neutral-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.03] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <span className="font-bold text-neutral-800 dark:text-neutral-100">{left.text}</span>
          <span className="hidden text-neutral-300 sm:block" aria-hidden="true">→</span>
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-wide text-neutral-500 dark:text-neutral-300">Associar com</span>
            <select value={pairs[left.id] || ''} onChange={(event) => setPairs((current) => ({ ...current, [left.id]: event.target.value }))} className="select py-2" aria-label={`Associar ${left.text} com`}>
              <option value="">Escolha uma opção</option>
              {definition.content.rightItems.map((right) => <option key={right.id} value={right.id} disabled={selectedValues.has(right.id) && pairs[left.id] !== right.id}>{right.text}</option>)}
            </select>
          </label>
        </div>
      ))}
    </div>
  );
}

function PrintCatalog({ examples }) {
  return (
    <section className="typed-lab-print-root" aria-label="Versão impressa do laboratório de formatos">
      <header className="mb-8 border-b-2 border-black pb-4">
        <p className="text-sm font-bold uppercase tracking-widest">LabMathic · Exemplos de questões</p>
        <h1 className="mt-2 text-2xl font-black">Exemplos para responder no papel</h1>
        <p className="mt-2 text-sm">Material demonstrativo. Nome: __________________________________</p>
        <p className="mt-2 text-sm">Turma: ______________ Data: ____/____/______</p>
      </header>
      <div className="space-y-7">
        {examples.map((example, index) => <PrintableExample key={example.id} example={example} index={index} />)}
      </div>
    </section>
  );
}

function PrintableExample({ example, index }) {
  const { definition } = example;
  const content = definition.content;
  return (
    <article className="typed-lab-print-item border border-black p-4">
      <p className="text-xs font-bold uppercase">{index + 1}. {example.typeLabel}</p>
      <h2 className="mt-2 text-base font-bold">{content.stem}</h2>
      {content.supportText && <p className="mt-1 text-sm">{definition.interactionType === 'ordering' ? 'Escreva os números na ordem indicada.' : definition.interactionType === 'numeric' ? 'Escreva apenas o valor numérico.' : content.supportText}</p>}
      <PrintableResponse definition={definition} />
      <p className="mt-3 text-xs italic">{definition.print.instructions}</p>
    </article>
  );
}

function PrintableResponse({ definition }) {
  const content = definition.content;
  if (['single_choice', 'multiple_response'].includes(definition.interactionType)) {
    return <ul className="mt-3 grid gap-2">{content.choices.map((choice) => <li key={choice.id}>□ {choice.text}</li>)}</ul>;
  }
  if (definition.interactionType === 'true_false') return <p className="mt-3">□ Verdadeiro&nbsp;&nbsp;&nbsp;&nbsp; □ Falso</p>;
  if (definition.interactionType === 'numeric') return <p className="mt-5">Resposta: ______________________________ {content.unit || ''}</p>;
  if (definition.interactionType === 'fill_blank') {
    const prompt = content.prompt.replace(/\{\{[a-z][a-z0-9_-]*\}\}/g, '________________');
    return <p className="mt-5 leading-8">{prompt}</p>;
  }
  if (definition.interactionType === 'ordering') return <div className="mt-3"><p>Itens: {content.items.map((item) => item.text).join(' · ')}</p><p className="mt-3">Ordem: {content.items.map((_, i) => (i + 1) + '. ____________').join('  ')}</p></div>;
  return (
    <table className="mt-3 w-full border-collapse text-sm">
      <thead><tr><th className="border border-black p-2 text-left">Coluna A</th><th className="border border-black p-2 text-left">Coluna B</th></tr></thead>
      <tbody>{content.leftItems.map((left, index) => <tr key={left.id}><td className="border border-black p-2">{index + 1}. {left.text} · Letra: ____</td><td className="border border-black p-2">{String.fromCharCode(65 + index)}. {content.rightItems[index]?.text || ''}</td></tr>)}</tbody>
    </table>
  );
}
