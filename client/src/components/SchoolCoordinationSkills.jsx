import { useCallback } from 'react';
import AssessmentDialog from './AssessmentDialog';
import useHomeResource from '../hooks/useHomeResource';
import { coordinationCount, coordinationDate, coordinationResultText, parseCoordinationSkills } from '../services/schoolCoordinationView.mjs';

export default function SchoolCoordinationSkills({ identity, schoolId, classId, onClose }) {
  const parse = useCallback(data => parseCoordinationSkills(data, schoolId, classId), [schoolId, classId]);
  const resource = useHomeResource(`/school-coordination/schools/${encodeURIComponent(schoolId)}/classes/${encodeURIComponent(classId)}/skills`, identity, parse);
  const data = resource.data, result = data?.result;
  return <AssessmentDialog title="Habilidades da turma" onClose={onClose}>
    <div data-coordination-skills className="space-y-3 p-3 text-sm leading-6 sm:p-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>Última avaliação encerrada · consulta atual</p>
        <button className="btn-outline min-h-11" disabled={resource.status === 'loading'} onClick={resource.retry}>Atualizar habilidades</button>
      </div>
      {resource.status === 'loading' && <p role="status">Conferindo o acesso e reunindo as habilidades…</p>}
      {resource.status === 'error' && <p role="alert">Não foi possível consultar as habilidades. Tente atualizar. Se continuar, peça à administração para conferir a liberação e os vínculos da escola. Os resultados anteriores foram ocultados.</p>}
      {data && <>
        <header><h3 className="text-base font-bold">{data.class.name} · {data.class.academicYear}</h3>
          <p>{data.class.gradeName} · {data.school.name} · {data.school.municipality}</p>
          {result && <p>Encerrada em {coordinationDate(result.closedAt)} (Brasília)</p>}
        </header>
        <p className="font-semibold">{coordinationResultText(result)}</p>
        {result?.status === 'available' && <>
          <p>Combine com o professor quais habilidades retomar. É o resultado de uma atividade, não um diagnóstico definitivo.</p>
          <ul aria-label="Resultados por habilidade" className="divide-y divide-slate-200 dark:divide-white/10">
            {result.skills.map(skill => <li key={skill.code ?? 'unmapped'} className="space-y-1 py-3">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <h4 className="min-w-0 flex-1 basis-52 font-bold">{skill.description || skill.code || 'Sem habilidade informada'}</h4>
                <p className="font-semibold">{skill.status === 'available'
                  ? `${skill.successRate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% de acertos`
                  : 'Percentual indisponível'}</p>
              </div>
              <p className="text-slate-600 dark:text-slate-300">{skill.code && `${skill.code} · `}{coordinationCount(skill.questionCount, 'questão', 'questões')} nesta avaliação</p>
              {skill.status === 'unavailable' ? <p>Há registros de correção incompletos. Peça ao professor para conferir os resultados antes de interpretar esta habilidade.</p>
                : skill.code && skill.questionCount === 1 && <p>Uma questão é apenas um indício. Confirme com outra atividade ou com a observação em aula.</p>}
              {!skill.code && <p>Estas questões não permitem concluir qual habilidade precisa de apoio. Confira a classificação das próximas atividades.</p>}
            </li>)}
          </ul>
          <details className="rounded-lg border border-slate-200 p-3 dark:border-white/10">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold">Como usar estes resultados?</summary>
            <div className="space-y-2">
              <p>Comece por uma habilidade com mais dificuldade, converse com o professor sobre exemplos observados em aula e combinem uma atividade curta para retomá-la. Depois, confiram a aprendizagem com novas questões.</p>
              <p>O percentual de cada habilidade divide os acertos pelas questões daquela habilidade em todas as {coordinationCount(result.correctedCount, 'correção concluída', 'correções concluídas')}. Questões deixadas em branco em uma correção concluída contam como não acertadas. Correções pendentes, anuladas e dispensas não entram.</p>
              <p>As habilidades com menores percentuais aparecem primeiro, seguidas das que têm registros incompletos. Questões sem habilidade informada ficam ao final. A consulta reúne questões objetivas e numéricas já corrigidas. Não inclui resultados individuais, gabaritos nem anotações do professor.</p>
              <p>São resultados atuais de uma única avaliação, não uma comparação de evolução. Podem mudar após novas correções ou outro encerramento. Não use para ranquear professores, turmas ou escolas. Nenhum plano é criado automaticamente.</p>
            </div>
          </details>
        </>}
      </>}
    </div>
  </AssessmentDialog>;
}
