import { useMemo } from 'react';
import ModalLayer from '../ModalLayer';
import useHomeResource from '../../hooks/useHomeResource';
import { accessFlagLabels, accessReason, teacherAccessView } from '../../services/teacherAccessView.mjs';

const button = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5';
export default function TeacherAccessDialog({ id, identity, onClose }) {
  const parse = useMemo(() => data => teacherAccessView(data, id), [id]);
  const resource = useHomeResource('/users/' + id + '/access-check', identity, parse);
  const data = resource.status === 'ready' ? resource.data : null;
  const work = data?.features.filter(feature => feature.group === 'work').sort((a, b) => Number(a.enabled) - Number(b.enabled));
  const pilots = data?.pilotFeatures?.slice().sort((a, b) => Number(a.enabled) - Number(b.enabled));
  const tools = [...(work || []), ...(pilots || [])];
  const blocked = tools.filter(feature => !feature.enabled).length;
  return <ModalLayer label="Conferir acesso do professor" onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm">
    <section data-admin-users data-teacher-access className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 dark:border-white/10 dark:bg-[#111E31] dark:text-slate-100">
      <header className="flex items-start justify-between gap-2"><h2 className="py-2 text-lg font-bold">Acesso do professor</h2><button type="button" className={button + ' shrink-0'} onClick={onClose}>Fechar</button></header>
      <p className="text-sm leading-6">Esta consulta não muda permissões e fica registrada na auditoria.</p>
      {resource.status === 'loading' && <p role="status" className="py-4 text-sm">Conferindo as liberações desta conta…</p>}
      {resource.status === 'error' && <div role="alert" className="mt-3 rounded-xl bg-slate-100 p-3 text-sm leading-6 dark:bg-white/5"><p>Não foi possível conferir o acesso. Isso não significa que o professor esteja sem acesso. A conta ou sua sessão também pode ter mudado.</p><button type="button" className={button} onClick={resource.retry}>Tentar novamente</button></div>}
      {data && <>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3 dark:border-white/10">
          <div className="min-w-0 break-words"><h3 className="font-bold">{data.user.name}</h3><p className="break-all text-sm text-slate-600 dark:text-slate-300">{data.user.email}</p></div>
          <button type="button" className={button} onClick={resource.retry}>Conferir novamente</button>
        </div>
        <p role="status" className="mt-3 text-sm font-semibold">{blocked ? `${blocked} de ${tools.length} ferramentas consultadas com liberação pendente.` : `As ${tools.length} ferramentas consultadas estão liberadas para esta conta.`}</p>
        <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">Liberação não confirma que escola, turma ou avaliação estejam prontas. Esta consulta não abre dados de estudantes nem testa o funcionamento dos serviços.</p>
        <h3 className="mt-4 text-sm font-bold">Novas ferramentas em teste</h3>
        {pilots ? <ul aria-label="Liberações das novas ferramentas" className="mt-1 divide-y divide-slate-200 dark:divide-white/10">{pilots.map(feature => <AccessRow key={feature.id} feature={feature} />)}</ul>
          : <p role="status" className="mt-2 rounded-xl bg-slate-100 p-3 text-sm dark:bg-white/5">O servidor ainda não informa os acessos às novas ferramentas. Isso não significa que estejam liberadas ou bloqueadas. Confira novamente após a atualização.</p>}
        <h3 className="mt-4 text-sm font-bold">Ferramentas do ciclo pedagógico</h3>
        <ul aria-label="Liberações do ciclo pedagógico" className="mt-3 divide-y divide-slate-200 dark:divide-white/10">{work.map(feature => <AccessRow key={feature.id} feature={feature} />)}</ul>
        <details className="mt-3 rounded-xl border border-slate-200 px-3 dark:border-white/10">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">Exemplos · não salvam atividades</summary>
          <ul aria-label="Liberações dos exemplos" className="divide-y divide-slate-200 dark:divide-white/10">{data.features.filter(feature => feature.group === 'examples').map(feature => <AccessRow key={feature.id} feature={feature} />)}</ul>
        </details>
        <footer className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300"><p>Conferido em <time dateTime={data.checkedAt}>{new Date(data.checkedAt).toLocaleString('pt-BR')}</time>. As liberações podem mudar depois.</p><p>Se houver bloqueio, encaminhe o nome da ferramenta e o motivo ao responsável técnico. Nenhuma liberação é feita nesta tela.</p></footer>
      </>}
    </section>
  </ModalLayer>;
}

function AccessRow({ feature }) {
  return <li className="py-3" data-access-feature={feature.id}>
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1"><h4 className="text-sm font-semibold">{feature.title}</h4><span className={'text-xs font-bold leading-5 ' + (feature.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-200')}>{feature.enabled ? 'Liberado' : 'Não liberado'}</span></div>
    {feature.hint && <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{feature.hint}</p>}
    {!feature.enabled && <ul className="mt-1 space-y-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{feature.checks.filter(check => !check.enabled).map(check => <li key={check.key}>{accessFlagLabels[check.key]}: {accessReason(check)}</li>)}</ul>}
    <details className="mt-1 text-xs leading-5"><summary className="min-h-11 w-fit cursor-pointer py-3 font-semibold text-blue-700 dark:text-cyan-200">Como este acesso foi definido</summary><ul className="space-y-1 pb-1 text-slate-600 dark:text-slate-300">{feature.checks.map(check => <li key={check.key}>{accessFlagLabels[check.key]}: {accessReason(check)}</li>)}</ul></details>
  </li>;
}
