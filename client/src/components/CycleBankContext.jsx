import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';

export default function CycleBankContext({ classId, questionSetId, readyToApply = false, compact = false }) {
  const [state, setState] = useState({ id: null, data: null, error: '' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!classId) return;
    const controller = new AbortController();
    setState({ id: classId, data: null, error: '' });
    api.get(`/pedagogical-cycle/classes/${encodeURIComponent(classId)}`, { signal: controller.signal, timeout: 15000 })
      .then(response => {
        const value = response.data?.class;
        if (!value || typeof value.name !== 'string' || typeof value.gradeName !== 'string' || !value.institution) throw new Error('Turma não confirmada.');
        if (!controller.signal.aborted) setState({ id: classId, data: value, error: '' });
      })
      .catch(error => { if (!controller.signal.aborted) setState({ id: classId, data: null, error: error.response?.data?.error || 'Não foi possível confirmar a turma.' }); });
    return () => controller.abort();
  }, [classId, retry]);
  const schoolClass = state.id === classId ? state.data : null;
  if (compact) return <section data-bank-context aria-label="Contexto do ciclo pedagógico" className="rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 dark:border-white/10 dark:bg-[#111E31] dark:text-slate-200">
    <details><summary className="cursor-pointer py-2 font-semibold">{schoolClass ? `Turma: ${schoolClass.name} · ${schoolClass.gradeName}` : 'Usar com uma turma (opcional)'}</summary>
      <div className="space-y-2 pb-3"><p>Você pode consultar o banco sem escolher uma turma. A seleção de questões não altera avaliações já aplicadas.</p>
        {schoolClass && <p className="break-words">{schoolClass.academicYear} · {schoolClass.institution.school || 'Escola não informada'}{schoolClass.institution.municipality ? ` · ${schoolClass.institution.municipality}` : ''} · {schoolClass.institution.status === 'verified' ? 'Vínculo confirmado' : 'Vínculo a confirmar'}</p>}
        <Link className="btn-outline" to={`/banco-questoes/devolutivas${schoolClass ? `?turma=${encodeURIComponent(classId)}` : ''}`}>{schoolClass ? 'Acompanhar turma e devolutivas' : 'Escolher turma para o ciclo'}</Link>
      </div>
    </details>
    {classId && !schoolClass && state.id === classId && state.error && <p role="alert" className="pb-2 text-rose-700 dark:text-rose-300">{state.error} <button type="button" className="btn-outline" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></p>}
    {classId && !schoolClass && !(state.id === classId && state.error) && <p role="status" className="pb-2">Confirmando acesso à turma…</p>}
    {schoolClass && questionSetId && readyToApply && schoolClass.status === 'active' && <Link className="btn-primary mb-2" to={`/turmas?turma=${encodeURIComponent(classId)}&secao=avaliacoes&simulado=${questionSetId}`}>Preparar aplicação nesta turma</Link>}
  </section>;
  return <section className="mb-6 rounded-2xl border border-cyan-200 bg-cyan-50 p-4 text-cyan-950 dark:border-cyan-400/20 dark:bg-cyan-400/10 dark:text-cyan-100" aria-label="Contexto do ciclo pedagógico">
    <p className="text-xs font-bold uppercase tracking-widest">Banco 2.0 · acervo real</p>
    <h2 className="mt-1 font-bold">{schoolClass ? `${schoolClass.name} · ${schoolClass.gradeName} · ${schoolClass.academicYear}` : 'Instituição → turma → diagnóstico → intervenção → verificação'}</h2>
    <p className="mt-2 text-sm">{questionSetId ? 'Revise este instrumento antes de preparar sua aplicação na turma.' : 'Busque questões, consulte o gabarito, crie questões autorais e gere um diagnóstico revisável. A seleção não altera aplicações anteriores.'}</p>
    {schoolClass?.institution.school && <p className="mt-2 text-sm">{schoolClass.institution.municipality} · {schoolClass.institution.school} · {schoolClass.institution.status === 'verified' ? 'Vínculo confirmado' : 'Vínculo a confirmar'}</p>}
    {classId && !schoolClass && !state.error && <p role="status" className="mt-3 text-sm">Confirmando acesso à turma…</p>}
    {classId && state.error && <p role="alert" className="mt-3 text-sm">{state.error} <button className="underline" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></p>}
    <div className="mt-3 flex flex-wrap gap-3">
      <Link className="btn-outline" to={`/banco-questoes/devolutivas${schoolClass ? `?turma=${encodeURIComponent(classId)}` : ''}`}>{schoolClass ? 'Acompanhar turma e devolutivas' : 'Escolher turma para o ciclo'}</Link>
      {schoolClass && questionSetId && readyToApply && schoolClass.status === 'active' && <Link className="btn-primary" to={`/turmas?turma=${encodeURIComponent(classId)}&secao=avaliacoes&simulado=${questionSetId}`}>Preparar aplicação nesta turma</Link>}
      {schoolClass && questionSetId && !readyToApply && <p className="self-center text-sm">Confirme a revisão do diagnóstico para continuar.</p>}
    </div>
  </section>;
}
