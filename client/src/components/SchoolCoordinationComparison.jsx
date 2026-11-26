import { useCallback } from 'react';
import useHomeResource from '../hooks/useHomeResource';
import { coordinationCount, coordinationDate } from '../services/schoolCoordinationView.mjs';
import { parseSchoolComparison, schoolComparisonDifference } from '../services/schoolCoordinationComparisonView.mjs';

export default function SchoolCoordinationComparison({ identity, schoolId, classId, planId }) {
  const parse = useCallback(data => parseSchoolComparison(data, schoolId, classId, planId), [schoolId, classId, planId]);
  const resource = useHomeResource(`/school-coordination/schools/${encodeURIComponent(schoolId)}/classes/${encodeURIComponent(classId)}/support/${encodeURIComponent(planId)}/comparison`, identity, parse);
  const comparison = resource.data?.comparison;
  return <div data-coordination-comparison className="space-y-3 border-t border-slate-200 pt-3 dark:border-white/10">
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-bold">Diagnóstico e nova avaliação</h5>
      <button className="btn-outline min-h-11" onClick={resource.retry} disabled={resource.status === 'loading'}>Atualizar comparação</button></div>
    {resource.status === 'loading' && <p role="status">Conferindo o acesso e comparando os registros das duas etapas…</p>}
    {resource.status === 'error' && <p role="alert">Não foi possível consultar a comparação. Tente atualizar. Se continuar, confira a liberação e os vínculos com a administração. Os dados anteriores foram ocultados.</p>}
    {comparison && <>
      <p className="text-slate-600 dark:text-slate-300">Diagnóstico encerrado em {coordinationDate(comparison.sourceClosedAt)}{comparison.verificationClosedAt && ` · nova avaliação encerrada em ${coordinationDate(comparison.verificationClosedAt)}`} (Brasília).</p>
      {comparison.status === 'awaiting_verification' && <p>A comparação ficará disponível quando a avaliação vinculada a este plano estiver encerrada e houver correções suficientes nas duas etapas.</p>}
      {comparison.status === 'protected' && <p>Comparação não exibida. Cada habilidade precisa de pelo menos 5 estudantes com correções completas nas duas etapas. Isso não significa ausência de aprendizagem. Confira os registros com o professor.</p>}
      {comparison.status === 'available' && <>
        <p>Para cada habilidade, entram somente os mesmos estudantes nas duas etapas. A mudança nos acertos, sozinha, não prova que o apoio causou melhora ou piora.</p>
        {comparison.hasProtectedSkills && <p className="rounded-lg bg-slate-100 p-2 dark:bg-white/5">Nem todas as habilidades puderam ser exibidas com segurança. Não use este recorte como resultado de todo o plano.</p>}
        <ul aria-label="Comparação por habilidade" className="divide-y divide-slate-200 dark:divide-white/10">{comparison.skills.map(skill => <li key={skill.code} className="space-y-2 py-3">
          <h6 className="font-bold">{skill.description}</h6>
          <p className="text-slate-600 dark:text-slate-300">{skill.code} · {coordinationCount(skill.studentCount, 'estudante comparado', 'estudantes comparados')} nesta habilidade</p>
          <dl className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
            <Stage label="Diagnóstico" result={skill.diagnostic} />
            <Stage label="Nova avaliação" result={skill.verification} />
          </dl>
          <p className="font-semibold">{schoolComparisonDifference(skill.difference)}</p>
          {Math.min(skill.diagnostic.questionCount, skill.verification.questionCount) < 3 && <p>Poucas questões: este resultado é um indício. Confirme com outras atividades e observações em aula.</p>}
        </li>)}</ul>
        <details><summary className="min-h-11 cursor-pointer py-2 font-semibold">Como interpretar a comparação?</summary><div className="space-y-2">
          <p>O percentual divide os acertos pelo número de respostas consideradas naquela habilidade. Exemplo: de 40% para 60% são 20 pontos percentuais a mais, não 20% de melhora na aprendizagem.</p>
          <p>Entram correções concluídas e completas. Dispensas, tentativas anuladas e registros incompletos ficam fora. Uma questão em branco numa correção concluída conta como não acertada.</p>
          <p>Os grupos podem variar entre habilidades. Não some os estudantes nem use esta lista como média da turma. Grupos com menos de 5 estudantes em comum não são divulgados.</p>
          <p>São as duas avaliações vinculadas a este plano. A quantidade, a dificuldade e o contexto das questões podem variar. A comparação não mede proficiência nem serve para ranquear turmas ou professores.</p>
          <p>Conversem sobre o que foi observado em sala e o que ainda precisa de apoio. Nenhum plano é concluído ou alterado por esta consulta. Os números podem mudar após revisão das correções; atualize antes de interpretá-los.</p>
        </div></details>
      </>}
    </>}
  </div>;
}

function Stage({ label, result }) {
  return <div className="rounded-lg bg-slate-50 p-2 dark:bg-white/5"><dt className="font-semibold">{label}</dt>
    <dd><span className="text-lg font-bold">{result.successRate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%</span> de acertos</dd>
    <dd className="text-slate-600 dark:text-slate-300">{coordinationCount(result.questionCount, 'questão', 'questões')} · {coordinationCount(result.opportunities, 'resposta considerada', 'respostas consideradas')}</dd>
  </div>;
}
