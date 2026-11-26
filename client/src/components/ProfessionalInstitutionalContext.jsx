import { ArrowRight, CheckCircle2, ChevronDown, GraduationCap, School } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import InstitutionalManagementPanel from './InstitutionalManagementPanel';

const classStatuses = {
  verified: { label: 'Escola confirmada', style: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200' },
  linked: { label: 'Escola a confirmar', style: 'bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200' },
  pending: { label: 'Escola não vinculada', style: 'bg-neutral-100 text-neutral-700 dark:bg-white/10 dark:text-slate-200' },
};

const contextDescriptions = {
  verified_context: 'Há pelo menos uma turma com escola confirmada. Veja a situação de cada turma na lista.',
  awaiting_verification: 'Há turmas com escola indicada que ainda precisam de conferência.',
  membership_ready: 'Seu vínculo com a escola ou a rede está registrado. Falta conferir a escola das suas turmas.',
  pending_institutional_link: 'Falta vincular suas turmas a uma escola. Você pode continuar usando suas turmas normalmente.',
  no_context: 'Ainda não há escola ou turma vinculada à sua conta. Peça à administração para conferir seu cadastro.',
};

const surface = 'rounded-2xl border border-neutral-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const quietText = 'text-sm leading-5 text-neutral-600 dark:text-slate-300';
const touchLink = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold text-primary-700 hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 dark:text-cyan-200 dark:hover:bg-white/5';

export default function ProfessionalInstitutionalContext({ model, operationalPilot, onChanged }) {
  const { isEnabled } = useFeatureFlags();
  const canOpenClasses = isEnabled('classes.core');
  const activeClasses = (model.classes || []).filter(item => item.status !== 'archived');
  const archivedClasses = (model.classes || []).filter(item => item.status === 'archived');
  const memberships = model.memberships || [];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 bg-[#F8FAFC] px-4 py-4 dark:bg-transparent sm:px-6" data-professional-context>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-white sm:text-2xl">Minha escola e minhas turmas</h1>
        <span className="text-xs font-semibold text-neutral-600 dark:text-slate-300">{operationalPilot ? 'Ambiente de testes' : 'Ambiente de testes · Somente consulta'}</span>
      </header>

      <MembershipSummary memberships={memberships} />

      {operationalPilot && <InstitutionalManagementPanel compact onChanged={onChanged} />}

      <section className={`${surface} overflow-hidden`} aria-labelledby="my-institutional-classes">
        <div className="flex flex-wrap items-center justify-between gap-x-3 border-b border-neutral-200 px-4 py-2 dark:border-white/10">
          <h2 id="my-institutional-classes" className="flex items-center gap-2 py-2 text-base font-bold text-neutral-900 dark:text-white"><GraduationCap size={20} className="shrink-0 text-cyan-700 dark:text-cyan-300" />Minhas turmas</h2>
          {canOpenClasses && <Link to="/turmas" className={touchLink}>Ver todas</Link>}
        </div>
        {activeClasses.length > 0 ? (
          <ul className="divide-y divide-neutral-200 dark:divide-white/10">
            {activeClasses.map(item => <ClassRow key={item.publicId} item={item} canOpen={canOpenClasses} />)}
          </ul>
        ) : (
          <div className="px-4 py-4">
            <p className="font-semibold text-neutral-900 dark:text-white">Nenhuma turma ativa por aqui.</p>
            <p className={`mt-1 ${quietText}`}>{canOpenClasses ? 'Na área Turmas, você pode cadastrar uma turma ou consultar as arquivadas.' : 'Peça à administração para conferir seu cadastro e o acesso às turmas.'}</p>
          </div>
        )}
        {!canOpenClasses && activeClasses.length > 0 && <p className={`border-t border-neutral-200 px-4 py-3 dark:border-white/10 ${quietText}`}>Você pode consultar os vínculos aqui. Para trabalhar com a turma, peça à administração para liberar a área Turmas para sua conta.</p>}
      </section>

      {archivedClasses.length > 0 && <details className={`${surface} group`}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-semibold text-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500 dark:text-slate-200 [&::-webkit-details-marker]:hidden">
          Turmas arquivadas ({archivedClasses.length})<ChevronDown size={18} className="shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <p className={`px-4 pb-3 ${quietText}`}>{canOpenClasses ? 'Estas turmas estão guardadas para consulta. Para abri-las, use a opção Arquivadas na área Turmas.' : 'Estas turmas estão guardadas para consulta. Peça à administração para liberar a área Turmas para sua conta.'}</p>
        <ul className="divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-white/10 dark:border-white/10">{archivedClasses.map(item => <ClassRow key={item.publicId} item={item} canOpen={false} />)}</ul>
      </details>}

      <details className={`${surface} group`}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-semibold text-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500 dark:text-slate-200 [&::-webkit-details-marker]:hidden">
          Sobre as escolas e as confirmações<ChevronDown size={18} className="shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className={`space-y-2 px-4 pb-4 ${quietText}`}>
          <p>{contextDescriptions[model.status] || contextDescriptions.no_context}</p>
          <p>Você vê somente seus vínculos e suas turmas. A escola não é escolhida automaticamente pelo seu nome ou e-mail.</p>
          <p>{operationalPilot ? 'A administração prepara a turma e você confere os dados antes de confirmar. As confirmações ficam registradas neste ambiente de testes, sem alterar o sistema em uso nas escolas.' : 'Esta página é apenas para consulta: não cria nem altera vínculos.'}</p>
          <p>Uma escola ainda não confirmada não impede o trabalho com a turma. A confirmação permite incluí-la nos totais da escola.</p>
          <p>Encontrou uma escola ou um vínculo incorreto? Peça à administração para conferir seu cadastro.</p>
        </div>
      </details>
    </div>
  );
}

function MembershipSummary({ memberships }) {
  if (!memberships.length) return <p className={`rounded-xl bg-neutral-100 px-4 py-3 dark:bg-white/5 ${quietText}`}>Nenhuma escola vinculada à sua conta. Peça à administração para conferir seu cadastro.</p>;
  if (memberships.length === 1) return <div className={`${surface} flex items-start gap-3 px-4 py-3`}><School size={20} className="mt-0.5 shrink-0 text-cyan-700 dark:text-cyan-300" /><Membership item={memberships[0]} /></div>;
  return <details className={`${surface} group`}>
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-semibold text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500 dark:text-white [&::-webkit-details-marker]:hidden">
      Meus vínculos com escolas e rede ({memberships.length})<ChevronDown size={18} className="shrink-0 transition-transform group-open:rotate-180" />
    </summary>
    <ul className="divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-white/10 dark:border-white/10">{memberships.map(item => <li key={item.publicId} className="px-4 py-3"><Membership item={item} /></li>)}</ul>
  </details>;
}

function Membership({ item }) {
  return <div className="min-w-0 break-words"><p className="text-sm font-bold leading-5 text-neutral-900 dark:text-white">{item.schoolName || 'Secretaria municipal'} · {item.municipalityName}</p><p className={`mt-0.5 ${quietText}`}>{item.roleLabel}</p></div>;
}

function ClassRow({ item, canOpen }) {
  const status = classStatuses[item.migrationStatus] || classStatuses.pending;
  return <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-institutional-class>
    <div className="min-w-0 break-words">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h3 className="text-base font-bold leading-6 text-neutral-900 dark:text-white">{item.name}</h3><span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${status.style}`}>{item.migrationStatus === 'verified' && <CheckCircle2 size={14} />}{status.label}</span></div>
      <p className={`mt-1 ${quietText}`}>{item.gradeName || 'Ano escolar não informado'} · {item.academicYear}</p>
      {item.schoolName && <p className={`mt-1 ${quietText}`}>{item.schoolName} · {item.municipalityName}</p>}
    </div>
    {canOpen && <Link to={`/turmas?turma=${encodeURIComponent(item.publicId)}`} aria-label={`Abrir turma ${item.name}`} className={`${touchLink} shrink-0 self-start border border-neutral-200 dark:border-white/15 sm:self-center`}>Abrir turma<ArrowRight size={16} /></Link>}
  </li>;
}
