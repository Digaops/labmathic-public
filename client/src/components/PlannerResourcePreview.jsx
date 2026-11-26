import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import MaterialPreview from './MaterialPreview';
import { externalMaterialUrl, materialFileUrl } from '../services/materialView.mjs';
import { parsePlannerResourcePreview, plannerResourceError, plannerResourcePath } from '../services/plannerResourcePreview.mjs';

export default function PlannerResourcePreview({ resource }) {
  const [result, setResult] = useState(null), [attempt, setAttempt] = useState(0);
  const path = plannerResourcePath(resource);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    api.get(path, { signal: controller.signal, timeout: 15000 }).then(response => {
      const data = parsePlannerResourcePreview(response.data, { type: resource.type, id: resource.id });
      if (!controller.signal.aborted) setResult({ path, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ path, error: plannerResourceError(error) });
    });
    return () => controller.abort();
  }, [path, resource.type, resource.id, attempt]);
  if (!result || result.path !== path) return <p role="status">Abrindo recurso…</p>;
  if (result.error) return <div role="alert" className="space-y-2 text-amber-900 dark:text-amber-200">
    <p>{result.error}</p><p className="text-sm">O planejamento não foi alterado.</p>
    <button type="button" className="btn-outline min-h-11" onClick={() => setAttempt(value => value + 1)}>Tentar novamente</button>
  </div>;
  const { data } = result;
  return <section aria-label="Conteúdo do recurso" className="min-w-0 space-y-3 break-words">
    <h3 className="text-lg font-bold">{data.title}</h3>
    {data.type === 'material' ? <MaterialContent material={data.material} retry={() => setAttempt(value => value + 1)} />
      : <QuestionContent key={`${path}:${attempt}`} questions={data.questions} />}
  </section>;
}

function MaterialContent({ material, retry }) {
  const external = externalMaterialUrl(material.external_url);
  return <>
    {external && <a href={external} target="_blank" rel="noopener noreferrer" className="btn-outline inline-flex min-h-11 items-center">Abrir no site de origem (nova aba)</a>}
    <MaterialPreview material={material} fileUrl={materialFileUrl(material.file_path)} userRole="professor" restrictFeatures onRetry={retry} />
    {material.description && <details><summary className="min-h-11 cursor-pointer py-3 font-semibold">Sobre o material</summary><p className="whitespace-pre-wrap leading-relaxed">{material.description}</p></details>}
  </>;
}

function QuestionContent({ questions }) {
  const [index, setIndex] = useState(0);
  const heading = useRef(null);
  const question = questions[index];
  function change(next) { setIndex(next); heading.current?.focus(); heading.current?.scrollIntoView({ block: 'start' }); }
  return <>
    <p className="text-sm text-slate-600 dark:text-slate-300">Prévia sem gabarito. Confira o conteúdo antes de usar com a turma.</p>
    <h4 ref={heading} tabIndex={-1} className="font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-600" aria-live="polite">Questão {index + 1} de {questions.length} · {question.code}</h4>
    <p className="whitespace-pre-wrap text-base leading-relaxed">{question.statement}</p>
    {question.supportText && <p className="whitespace-pre-wrap text-base leading-relaxed">{question.supportText}</p>}
    {question.imagePath && <ResourceImage key={question.imagePath} path={question.imagePath} code={question.code} />}
    <ol className="divide-y divide-slate-200 dark:divide-white/10">{question.options.map(option => <li key={option.label} className="flex gap-3 py-3 text-base"><span className="font-semibold">{option.label}.</span><span className="min-w-0 whitespace-pre-wrap">{option.text}</span></li>)}</ol>
    <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">Habilidade BNCC · {question.skillCode}</summary><p className="text-base leading-relaxed">{question.skillDescription}</p></details>
    {questions.length > 1 && <nav aria-label="Questões do simulado" className="flex flex-wrap gap-2">
      <button type="button" className="btn-outline min-h-11" disabled={index === 0} onClick={() => change(index - 1)}>Questão anterior</button>
      <button type="button" className="btn-outline min-h-11" disabled={index === questions.length - 1} onClick={() => change(index + 1)}>Próxima questão</button>
    </nav>}
  </>;
}

function ResourceImage({ path, code }) {
  const [failed, setFailed] = useState(false);
  const src = materialFileUrl(path);
  return !src || failed ? <p role="status" className="text-sm text-amber-900 dark:text-amber-200">A imagem desta questão está indisponível. Confira o material antes de usá-lo com a turma.</p>
    : <img src={src} alt={`Imagem da questão ${code}; a descrição detalhada depende do material de origem.`} onError={() => setFailed(true)} className="max-h-80 max-w-full object-contain" />;
}
