import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import useDemoResource from '../hooks/useDemoResource';
import { DemoHeader, DemoSelect, DemoReadState, DemoPrintState, demoPanel } from '../components/DemoWorkspace';
import { demoViews, parseFeedbackCatalog, parseFeedbackDetail } from '../services/demoView.mjs';

export default function TypedQuestionFeedbackLab() {
  const [params, setParams] = useSearchParams();
  const catalog = useDemoResource('/question-bank/feedback-preview/catalog', parseFeedbackCatalog);
  const examples = catalog.data?.examples || [];
  const selectedId = params.get('exemplo') || examples[0]?.id || '';
  const selected = examples.find(e => e.id === selectedId);
  const view = params.get('visao') || 'teacher';
  const validView = demoViews.some(v => v.value === view);
  const parse = useCallback(data => parseFeedbackDetail(data, selectedId, view), [selectedId, view]);
  const result = useDemoResource(selected && validView ? '/question-bank/feedback-preview/examples/' + encodeURIComponent(selectedId) + '?view=' + view : null, parse);
  const detail = result.data;
  function choose(key, value) {
    const next = new URLSearchParams(params);
    next.set(key, value); setParams(next);
  }
  return <div data-demo-feedback className="feedback-lab-page bank-form demo-workspace mx-auto max-w-5xl space-y-3 px-3 pb-8">
    <div className="feedback-lab-screen-only space-y-3">
      <DemoHeader title="Exemplos de devolutiva" />
      <DemoReadState resource={catalog} />
      {catalog.data && <>
        {examples.length ? <>
          <div className="grid gap-3 sm:grid-cols-2">
            <DemoSelect label="Exemplo matemático" value={selectedId} onChange={v => choose('exemplo', v)} options={[...(!selected ? [{ value: selectedId, label: 'Exemplo não encontrado' }] : []), ...examples.map(e => ({ value: e.id, label: e.title }))]} />
            <DemoSelect label="Quem está vendo e quando?" value={view} onChange={v => choose('visao', v)} options={[...(!validView ? [{ value: view, label: 'Visão não encontrada' }] : []), ...demoViews]} />
          </div>
          {(!selected || !validView) && <p role="alert">Escolha um exemplo e uma visão disponíveis.</p>}
          <DemoReadState resource={result} />
          {detail && <FeedbackWorkspace detail={detail} />}
        </> : <p className={demoPanel}>Nenhum exemplo disponível neste momento.</p>}
      </>}
      <button type="button" className="btn-outline" disabled={!detail?.feedback.available} onClick={() => window.print()}>Imprimir esta devolutiva</button>
      <p className="text-sm">A troca de visão apenas demonstra quando a explicação aparece. Nenhuma configuração de avaliação é alterada.</p>
    </div>
    {detail?.feedback.available ? <PrintGuide detail={detail} /> : <DemoPrintState className="feedback-lab-print-root" />}
  </div>;
}

function FeedbackWorkspace({ detail }) {
  const { example, feedback, view } = detail;
  const content = example.question.content;
  return <article className={demoPanel} data-demo-feedback-detail>
    <h2 className="text-lg font-bold">{content.stem}</h2>
    {content.supportText && <p className="mt-2 text-sm">{content.supportText}</p>}
    <p className="mt-3 text-sm"><strong>Resposta do exemplo:</strong> {example.response?.display || 'Ainda não entregue'}</p>
    <details className="mt-2"><summary className="cursor-pointer text-sm font-semibold">Ver alternativas e objetivo</summary>
      {content.choices && <ul className="mt-2 grid gap-2 sm:grid-cols-2">{content.choices.map(c => <li key={c.id} className="rounded-lg border border-slate-200 p-2 text-sm dark:border-white/10">{c.text}</li>)}</ul>}
      {content.unit && <p className="mt-2 text-sm">Unidade: {content.unit}</p>}
      <p className="mt-2 text-sm">{example.pedagogicalPurpose}</p>
      <p className="mt-2 text-sm">Neste exemplo: {example.releasePolicyLabel}.</p>
    </details>
    <p role="status" aria-live="polite" className="sr-only">{demoViews.find(v => v.value === view)?.label}. {feedback.available ? 'Devolutiva disponível.' : 'Devolutiva ainda não liberada.'}</p>
    {feedback.available ? <ReleasedFeedback feedback={feedback} view={view} /> : <section className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">
      <h3 className="font-bold">Devolutiva ainda não liberada</h3>
      <p className="mt-1 text-sm">{view === 'before_submission' ? 'O estudante ainda está respondendo. A explicação não aparece antes da entrega.' : example.releasePolicy === 'teacher_only' ? 'Neste exemplo, somente o professor pode ver a explicação.' : 'Neste exemplo, a explicação aparece para o estudante após o encerramento da avaliação.'}</p>
    </section>}
  </article>;
}

function ReleasedFeedback({ feedback, view }) {
  const { guide, evidence } = feedback;
  return <section className="mt-3 space-y-3" aria-label="Explicação da resposta">
    <div className="rounded-xl bg-cyan-50 p-3 text-cyan-950 dark:bg-cyan-400/10 dark:text-cyan-100">
      <h3 className="font-bold">Resposta esperada: {guide.referenceAnswer}</h3>
      <p className="mt-1 text-sm">{guide.summary}</p>
    </div>
    <section><h3 className="font-bold">Uma atividade para ajudar</h3><p className="mt-1 text-sm">{guide.nextStep}</p></section>
    <details><summary className="cursor-pointer text-sm font-semibold">Ver a resolução passo a passo</summary>
      <ol className="list-decimal space-y-2 pl-6 text-sm">{guide.resolutionSteps.map((step, i) => <li key={i}>{step}</li>)}</ol>
    </details>
    <details><summary className="cursor-pointer text-sm font-semibold">O que essa resposta pode indicar?</summary>
      <p className="mt-2 text-sm">{guide.misconception}</p><p className="mt-2 text-sm">É uma hipótese para conversar com o estudante, não uma conclusão sobre sua aprendizagem.</p>
      <p className="mt-2 text-sm">Pontuação deste exemplo: {Math.round(evidence.score * 100)}%. É o resultado da regra da questão, não uma medida de toda a aprendizagem.</p>
    </details>
    {view === 'teacher' && guide.choiceInsights.length > 0 && <details><summary className="cursor-pointer text-sm font-semibold">O que observar em cada alternativa</summary>
      <ul className="divide-y divide-slate-200 dark:divide-white/10">{guide.choiceInsights.map(i => <li key={i.choice} className="py-2 text-sm"><strong>{i.choice}</strong><p>{i.insight}</p></li>)}</ul>
    </details>}
  </section>;
}

function PrintGuide({ detail }) {
  const { example, feedback } = detail;
  const guide = feedback.guide;
  return (
    <section className="feedback-lab-print-root" aria-label="Guia impresso da devolutiva pedagógica">
      <p className="text-xs font-bold uppercase">LabMathic · Exemplo de devolutiva</p>
      <h1 className="mt-2 text-2xl font-bold">{example.title}</h1>
      <p className="mt-1 text-sm">{example.typeLabel} · {demoViews.find(v => v.value === detail.view)?.label}</p>
      <div className="mt-5 border border-black p-4"><strong>Questão</strong><p className="mt-2">{example.question.content.stem}</p><p className="mt-3"><strong>Resposta do exemplo:</strong> {example.response?.display || 'Não entregue'}</p><p><strong>Resposta de referência:</strong> {guide.referenceAnswer}</p></div>
      <h2 className="mt-5 text-lg font-bold">Resolução comentada</h2>
      <ol className="mt-2 list-decimal space-y-2 pl-6">{guide.resolutionSteps.map((step) => <li key={step}>{step}</li>)}</ol>
      <h2 className="mt-5 text-lg font-bold">Hipótese a investigar</h2><p className="mt-2">{guide.misconception}</p>
      <h2 className="mt-5 text-lg font-bold">Próxima ação possível</h2><p className="mt-2">{guide.nextStep}</p>
      <p className="mt-8 border-t border-black pt-3 text-xs">Material demonstrativo, sem dados de estudante e sem valor de diagnóstico individual.</p>
    </section>
  );
}
