import ModalLayer from './ModalLayer';

export default function InstitutionalWriteReview({ dialog, send, check, cancel }) {
  if (!dialog) return null;
  const busy = ['saving', 'checking'].includes(dialog.stage);
  const uncertain = dialog.uncertain;
  const locked = busy || uncertain;
  return <ModalLayer label="Conferir envio institucional" className="fixed inset-0 z-[240] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm" onClose={cancel} closeDisabled={locked}>
    <section data-institutional-forms className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-2xl dark:border-white/15 dark:bg-[#111E31] dark:text-slate-100">
      <h2 className="text-lg font-bold">{dialog.kind === 'confirmation' ? 'Conferir a turma' : 'Conferir antes de salvar'}</h2>
      <p className="mt-2 text-sm leading-5 text-slate-600 dark:text-slate-300">{dialog.kind === 'confirmation' ? 'Confirme somente se esta turma e esta escola correspondem ao seu trabalho.' : 'Confira os dados. O cadastro será salvo no ambiente de testes e a operação ficará registrada.'}</p>
      <dl className="my-4 space-y-3">{dialog.summary.map(([label, value]) => <div key={label}><dt className="text-xs text-slate-600 dark:text-slate-300">{label}</dt><dd className="break-words text-sm font-semibold">{value}</dd></div>)}</dl>
      {dialog.kind === 'professional' && <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">A senha temporária não é exibida nesta conferência. Compartilhe-a somente com a pessoa responsável pela conta.</p>}
      {dialog.kind === 'class' && <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">O professor responsável deverá conferir a escola em sua própria conta. Não há confirmação automática.</p>}
      {dialog.message && <p role="alert" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:bg-amber-400/10 dark:text-amber-100">{dialog.message}</p>}
      {busy ? <p role="status" className="min-h-11 py-3 text-sm">{dialog.stage === 'saving' ? 'Enviando… Aguarde a confirmação.' : 'Conferindo…'}</p> : uncertain ? <div className="space-y-2"><button type="button" className="btn-primary min-h-11 w-full justify-center" onClick={check}>Conferir envio</button><button type="button" className="btn-secondary min-h-11 w-full justify-center" onClick={send}>Repetir o mesmo envio</button><p className="text-xs leading-5 text-slate-600 dark:text-slate-300">A repetição usa a mesma chave e os mesmos dados para evitar duplicidade. Não recarregue esta página enquanto o envio estiver sem confirmação.</p></div> : <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn-secondary min-h-11" onClick={cancel}>Voltar ao formulário</button>{dialog.stage !== 'rejected' && <button type="button" className="btn-primary min-h-11" onClick={send}>{dialog.kind === 'confirmation' ? 'Confirmar turma' : 'Confirmar e salvar'}</button>}</div>}
    </section>
  </ModalLayer>;
}
