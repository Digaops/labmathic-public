import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { operationalBankState, classReturnPath } from '../services/bankExperiences.mjs';

export default function OperationalBankAccess({ feedback = false, children }) {
  const { user } = useAuth();
  const flags = useFeatureFlags();
  const location = useLocation();
  const state = operationalBankState(user?.role, flags, { feedback });
  if (state === 'operational') return children;
  const title = feedback ? 'Devolutivas da turma' : 'Banco de questões para a turma';
  const classPath = classReturnPath(location.search);
  const canReturnToClasses = flags.isEnabled('classes.core') && user?.role === 'professor';
  const example = feedback ? ['question_bank.feedback_preview', '/exemplos/devolutivas']
    : ['question_bank.catalog_preview', '/exemplos/banco-questoes'];
  return <section data-bank-access={state} className="mx-auto max-w-3xl space-y-3 bg-slate-50 px-4 py-4 text-slate-900 dark:bg-transparent dark:text-slate-100 sm:px-6">
    <header><h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Área de trabalho com suas turmas. Aqui não usamos dados de demonstração.</p></header>
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-white/10 dark:bg-[#111e31]">
      {state === 'loading' ? <p role="status">Conferindo o acesso da sua conta…</p>
        : state === 'unavailable' ? <div role="alert"><h2 className="font-bold">Não foi possível conferir seu acesso</h2><p className="mt-1">Verifique a conexão e tente novamente. Isso não significa que o recurso está bloqueado para você.</p></div>
        : state === 'role_restricted' ? <><h2 className="font-bold">Esta área é usada pela conta do professor</h2><p>Para trabalhar com uma turma, entre com a conta docente responsável. A administração pode conhecer os exemplos separadamente.</p></>
        : <><h2 className="font-bold">Este recurso ainda não está liberado para sua conta</h2><p>Peça à equipe LabMathic para conferir a liberação deste recurso. Seu cadastro e seu trabalho nas outras áreas não foram alterados.</p></>}
      {state !== 'loading' && <div className="flex flex-wrap gap-2">
        {state !== 'role_restricted' && <button type="button" onClick={state === 'unavailable' ? () => window.location.reload() : flags.refresh} className="btn-primary">{state === 'unavailable' ? 'Recarregar página' : 'Conferir acesso novamente'}</button>}
        <Link to="/fale-conosco" className="btn-outline">Pedir ajuda</Link>
        <Link to={canReturnToClasses ? classPath : '/banco-questoes'} className="btn-outline">{canReturnToClasses ? classPath === '/turmas' ? 'Abrir minhas turmas' : 'Voltar às aplicações da turma' : 'Abrir banco de questões'}</Link>
      </div>}
    </div>
    {state !== 'loading' && !flags.unavailable && flags.isEnabled(example[0]) && <aside className="text-sm">
      <p>Quer apenas conhecer a proposta? Os exemplos usam dados inventados e não salvam atividades.</p>
      <Link to={example[1]} className="btn-outline mt-2">Ver somente exemplos</Link>
    </aside>}
  </section>;
}
