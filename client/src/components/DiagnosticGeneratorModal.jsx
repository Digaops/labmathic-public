import { useEffect, useRef, useState } from 'react';
import { CheckCircle, Circle, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import { parseDiagnosticBootstrap, parseDiagnosticResult, diagnosticSelection, uncertainWrite } from '../services/authoringView.mjs';
import AssessmentDialog from './AssessmentDialog';
import AuthoringWriteAlert from './AuthoringWriteAlert';
import { formatCount } from '../utils/pluralize';

export default function DiagnosticGeneratorModal({ onClose, onCreated }) {
  const { user } = useAuth();
  const [form, setForm] = useState({ gradeId: '', questionsPerSkill: 3, title: '' });
  const [step, setStep] = useState(0), [selected, setSelected] = useState([]);
  const [search, setSearch] = useState(''), [unitId, setUnitId] = useState('');
  const [result, setResult] = useState(null), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const [shortages, setShortages] = useState([]);
  const title = useRef(null), dirty = useRef(false);
  const action = useMaterialAction();
  const bootstrap = useReadOnlyResource('/question-bank/diagnostics/bootstrap', user?.id, parseDiagnosticBootstrap);
  const resource = useReadOnlyResource(form.gradeId ? '/question-bank/diagnostics/bootstrap?grade_id=' + form.gradeId : null, user?.id, parseDiagnosticBootstrap);
  const skills = resource.data?.skills || [], limits = bootstrap.data?.limits;
  const selectedDisplay = selected.map(s => {
    const current = skills.find(item => item.id === s.id);
    return resource.status === 'ready' ? { ...s, ...current, candidateCount: current?.candidateCount || 0 } : s;
  });
  const selection = diagnosticSelection(selectedDisplay, selected.map(s => s.id), form.questionsPerSkill);
  const term = search.trim().toLocaleLowerCase('pt-BR');
  const filtered = skills.filter(s => (!unitId || String(s.unitId) === unitId)
    && (!term || [s.code, s.description, s.unitName].some(value => value.toLocaleLowerCase('pt-BR').includes(term))));
  const canGenerate = resource.status === 'ready' && bootstrap.status === 'ready' && selected.length > 0
    && !selection.insufficient.length && selection.total <= limits.maxQuestions && !uncertain && !action.busy;
  useEffect(() => {
    title.current?.focus({ preventScroll: true }); title.current?.scrollIntoView({ block: 'start' });
  }, [step, result]);
  function close() {
    if (action.busy) return;
    if (!result && dirty.current && !window.confirm(uncertain
      ? 'O diagnóstico pode ter sido salvo. Fechar sem repetir o envio? Confira depois em Meus simulados.'
      : 'Sair sem gerar o diagnóstico? A seleção desta janela não será guardada.')) return;
    onClose();
  }
  function changeGrade(value) {
    dirty.current = true; setSelected([]); setUnitId(''); setSearch(''); setShortages([]); setError('');
    setForm(current => ({ ...current, gradeId: value }));
  }
  function toggleSkill(skill) {
    const included = selected.some(s => s.id === skill.id);
    if (included) { setSelected(current => current.filter(s => s.id !== skill.id)); return; }
    if (skill.candidateCount < form.questionsPerSkill) return;
    if (selected.length >= limits.maxSkills) return setError('Selecione no máximo ' + limits.maxSkills + ' habilidades.');
    dirty.current = true; setError(''); setShortages([]); setSelected(current => [...current, skill]);
  }
  function generate() {
    if (!canGenerate) return;
    setError(''); setShortages([]); let created;
    action.run(async () => {
      try {
        const response = await api.post('/question-bank/diagnostics/generate', {
          gradeId: Number(form.gradeId), skillIds: selected.map(s => s.id),
          questionsPerSkill: Number(form.questionsPerSkill), title: form.title.trim() || undefined,
        }, { timeout: 15000 });
        created = parseDiagnosticResult(response.data);
      } catch (failure) {
        if (uncertainWrite(failure)) setUncertain(true);
        const items = failure.response?.data?.details?.shortages;
        if (Array.isArray(items)) setShortages(items.filter(s => typeof s?.code === 'string' && Number.isInteger(s.available)).slice(0, 100));
        throw failure;
      }
    }, { onSuccess: () => setResult(created), onError: setError, message: 'Diagnóstico salvo como rascunho privado. Revise antes de usar.' });
  }
  const countOptions = limits ? Array.from({ length: limits.maxQuestionsPerSkill - limits.minQuestionsPerSkill + 1 }, (_, i) => i + limits.minQuestionsPerSkill) : [];
  return <AssessmentDialog title="Gerar avaliação diagnóstica" onClose={close} closeDisabled={action.busy}>
    <div data-diagnostic-generator className="bank-form space-y-3 p-3 sm:p-4">
      <h3 ref={title} tabIndex={-1} className="text-base font-bold outline-none">{result ? 'Diagnóstico preparado' : ['Etapa 1 de 3 — Escolha o ano', 'Etapa 2 de 3 — Escolha as habilidades', 'Etapa 3 de 3 — Confira antes de gerar'][step]}</h3>
      <AuthoringWriteAlert message={error} uncertain={uncertain} href="/simulados" onAcknowledge={() => { setUncertain(false); setError(''); }} />
      {shortages.length > 0 && <div role="alert" className="space-y-2 text-sm"><p>O acervo mudou. Há menos questões disponíveis:</p>
        <ul className="list-inside list-disc">{shortages.map(s => <li key={s.code}>{s.code}: {formatCount(s.available, 'questão disponível', 'questões disponíveis')}</li>)}</ul>
        <button type="button" className="btn-outline" onClick={resource.retry}>Atualizar disponibilidade</button>
      </div>}
      {!result && bootstrap.status === 'loading' && <p role="status" className="text-sm">Carregando anos escolares…</p>}
      {!result && bootstrap.status === 'error' && <div role="alert" className="space-y-2 text-sm"><p>Não foi possível preparar o diagnóstico. Suas escolhas não foram apagadas.</p><button type="button" className="btn-outline" onClick={bootstrap.retry}>Tentar novamente</button></div>}
      {!result && resource.status === 'loading' && <p role="status" className="text-sm">Conferindo as questões disponíveis para este ano…</p>}
      {!result && resource.status === 'error' && <div role="alert" className="space-y-2 text-sm"><p>Não foi possível consultar as habilidades deste ano.</p><button type="button" className="btn-outline" onClick={resource.retry}>Recarregar habilidades</button></div>}
      {result ? <section className="space-y-3 text-sm">
        <p><strong>{result.title}</strong> · {result.grade.name}</p>
        <p>{formatCount(result.questionCount, 'questão', 'questões')} em {formatCount(result.composition.length, 'habilidade', 'habilidades')}. Salvo como rascunho privado.</p>
        <p className="rounded-xl bg-amber-50 p-3 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">Antes de usar com a turma, confira enunciados, imagens e respostas e confirme sua revisão.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn-primary" onClick={() => onCreated(result.id)}>Abrir e revisar</button><button type="button" className="btn-outline" onClick={close}>Fechar</button></div>
        <details className="rounded-xl border border-slate-200 p-3 dark:border-white/10"><summary className="cursor-pointer font-semibold">Ver habilidades e quantidade de questões</summary>
          <ul className="mt-2 space-y-2">{result.composition.map(s => <li key={s.id}><strong>{s.code}</strong> — {s.description}<span className="block text-slate-600 dark:text-slate-300">{formatCount(s.selectedCount, 'questão', 'questões')}{s.editorialPilotCount > 0 && ` · ${formatCount(s.editorialPilotCount, 'questão do piloto', 'questões do piloto')}`}</span></li>)}</ul>
        </details>
      </section> : <fieldset disabled={action.busy} className="space-y-3">
        {step === 0 && <>
          <p className="text-sm text-slate-600 dark:text-slate-300">O sistema seleciona questões do banco. Você confere tudo antes de usar com a turma.</p>
          <label className="block"><span className="label">Ano escolar</span><select aria-label="Ano escolar" className="input" value={form.gradeId} disabled={bootstrap.status !== 'ready'} onChange={e => changeGrade(e.target.value)}><option value="">Selecione o ano</option>{bootstrap.data?.grades.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          {bootstrap.status === 'ready' && !bootstrap.data.grades.length && <p className="text-sm">Ainda não há questões disponíveis para gerar um diagnóstico. Você pode criar questões ou consultar o banco.</p>}
          <label className="block"><span className="label">Questões por habilidade</span><select aria-label="Questões por habilidade" className="input" disabled={!limits} value={form.questionsPerSkill} onChange={e => { dirty.current = true; setForm(current => ({ ...current, questionsPerSkill: Number(e.target.value) })); setShortages([]); }}>{countOptions.map(n => <option key={n} value={n}>{formatCount(n, 'questão', 'questões')}</option>)}</select></label>
          <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn-outline" onClick={close}>Cancelar</button><button type="button" className="btn-primary" disabled={!form.gradeId || resource.status !== 'ready' || bootstrap.status !== 'ready'} onClick={() => { setError(''); setStep(1); }}>Escolher habilidades</button></div>
        </>}
        {step === 1 && <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{formatCount(selected.length, 'habilidade selecionada', 'habilidades selecionadas')} · {selection.total} questões</span><button type="button" className="btn-primary" disabled={!selected.length || resource.status !== 'ready'} onClick={() => { setError(''); setStep(2); }}>Conferir seleção</button></div>
          {selection.insufficient.length > 0 && <p role="status" className="text-sm text-amber-900 dark:text-amber-100">Algumas habilidades têm menos questões que o solicitado. Retire-as da seleção ou volte e reduza a quantidade.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span className="label">Buscar habilidade</span><input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Código ou descrição" /></label>
            <label><span className="label">Unidade temática (opcional)</span><select aria-label="Unidade temática" className="input" value={unitId} disabled={resource.status !== 'ready'} onChange={e => setUnitId(e.target.value)}><option value="">Todas as unidades</option>{resource.data?.units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          </div>
          {(search || unitId) && <button type="button" className="btn-outline" onClick={() => { setSearch(''); setUnitId(''); }}>Limpar filtros</button>}
          {resource.status === 'ready' && <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">
            {filtered.map(s => {
              const included = selected.some(item => item.id === s.id), insufficient = s.candidateCount < form.questionsPerSkill;
              return <article key={s.id} data-diagnostic-skill={s.id} className="space-y-2 p-3 text-sm">
                <p><strong className="text-cyan-800 dark:text-cyan-200">{s.code}</strong> · {s.unitName}</p><p className="leading-relaxed">{s.description}</p>
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-slate-600 dark:text-slate-300">{formatCount(s.candidateCount, 'questão disponível', 'questões disponíveis')}</span>
                  <button type="button" className="btn-outline" aria-pressed={included} aria-label={(included ? 'Retirar ' : 'Selecionar ') + s.code} disabled={!included && insufficient} onClick={() => toggleSkill(s)}>{included ? <CheckCircle aria-hidden="true" size={16} /> : <Circle aria-hidden="true" size={16} />}{included ? 'Selecionada' : insufficient ? 'Poucas questões' : 'Selecionar'}</button>
                </div>
                {insufficient && <p className="text-xs text-amber-900 dark:text-amber-100">Solicitadas: {form.questionsPerSkill}. Volte para reduzir a quantidade ou escolha outra habilidade.</p>}
              </article>;
            })}
            {!filtered.length && <p className="p-3 text-sm">{skills.length ? 'Nenhuma habilidade corresponde aos filtros.' : 'Não há habilidades com questões disponíveis neste ano.'}</p>}
          </div>}
          <div className="flex flex-wrap justify-between gap-2"><button type="button" className="btn-outline" onClick={() => setStep(0)}>Voltar ao ano e quantidade</button><button type="button" className="btn-primary" disabled={!selected.length || resource.status !== 'ready'} onClick={() => { setError(''); setStep(2); }}>Conferir seleção</button></div>
        </>}
        {step === 2 && <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong>{formatCount(selection.total, 'questão', 'questões')} em {formatCount(selected.length, 'habilidade', 'habilidades')}</strong><button type="button" className="btn-outline" onClick={() => setStep(1)}>Alterar habilidades</button></div>
          <label className="block"><span className="label">Título (opcional)</span><input className="input" maxLength={200} value={form.title} onChange={e => { dirty.current = true; setForm(current => ({ ...current, title: e.target.value })); }} placeholder="Ex.: Diagnóstico inicial de números" /></label>
          <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">{selectedDisplay.map(s => <div key={s.id} data-diagnostic-selected={s.id} className="space-y-2 p-3 text-sm">
            <div className="flex items-center justify-between gap-2"><strong>{s.code}</strong><button type="button" className="btn-outline shrink-0" aria-label={'Retirar ' + s.code + ' da seleção'} onClick={() => setSelected(current => current.filter(item => item.id !== s.id))}><Trash2 aria-hidden="true" size={16} /></button></div>
            <p className="leading-relaxed">{s.description}</p><p>{form.questionsPerSkill} questões solicitadas · {s.candidateCount} disponíveis</p>
            {s.candidateCount < form.questionsPerSkill && <p className="text-amber-900 dark:text-amber-100">Faltam questões. Retire esta habilidade ou volte para reduzir a quantidade.</p>}
          </div>)}</div>
          {!selected.length && <p className="text-sm">Use Alterar habilidades para escolher pelo menos uma habilidade.</p>}
          <p className="text-sm text-slate-600 dark:text-slate-300">Será criado um rascunho privado, acessível a você e à administração. Nada será aplicado automaticamente.</p>
          <div className="flex flex-wrap justify-between gap-2"><button type="button" className="btn-outline" onClick={() => setStep(0)}>Alterar ano ou quantidade</button><button type="button" className="btn-primary" disabled={!canGenerate} onClick={generate}>{action.busy ? 'Gerando…' : 'Gerar diagnóstico'}</button></div>
        </>}
        <details className="rounded-xl border border-slate-200 px-3 text-sm dark:border-white/10"><summary className="cursor-pointer font-semibold">Como as questões são escolhidas?</summary>
          <p className="pb-3 leading-relaxed text-slate-600 dark:text-slate-300">São usadas questões ativas do banco ou criadas por você, com quatro alternativas e uma resposta correta. O sistema distribui as dificuldades disponíveis. A adequação à turma precisa da sua revisão. Os resultados mostram percentuais de acerto, não uma nota calculada pela TRI.</p>
        </details>
      </fieldset>}
    </div>
  </AssessmentDialog>;
}
