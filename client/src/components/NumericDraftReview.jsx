import { numericReviewQuestions } from '../services/numericDraftView.mjs';

export default function NumericDraftReview({ preview, headingRef, busy, conflict, onEdit, onPrint, onPrintStudent, onReload, reviewing = false, decisionPending = true }) {
  const d = preview.draft;
  return <div className="space-y-4">
    {!reviewing && <div className="flex flex-wrap items-center gap-2">
      <button className="btn-outline" disabled={busy} onClick={onEdit}>Voltar à questão</button>
      {!conflict && <button className="btn-primary" disabled={busy} onClick={onPrint}>{busy ? 'Conferindo…' : 'Preparar cópia do professor'}</button>}
      {!conflict && d.status==='approved' && <button className="btn-outline" disabled={busy} onClick={onPrintStudent}>Imprimir sem gabarito</button>}
    </div>}
    <h3 ref={headingRef} tabIndex={-1} className="font-bold outline-none">Confira a questão · Versão {d.version || 1}</h3>
    <p className="text-sm text-slate-600 dark:text-slate-300">{reviewing ? 'Conteúdo enviado pelo professor. Confira a habilidade, o enunciado e a resolução antes de decidir.' : d.status==='approved' ? 'Versão aprovada. Imprima sem gabarito ou, com o piloto liberado, selecione esta versão em Turmas → Aplicações → Respostas numéricas.' : 'Rascunho privado · A cópia inclui o gabarito. Aguarde a aprovação antes do uso em papel.'}</p>
    {conflict && <button className="btn-outline" disabled={busy} onClick={onReload}>Reabrir versão salva</button>}
    <section aria-label="Prévia da questão" className="space-y-3 rounded-xl border border-slate-300 p-4 dark:border-white/20">
      <h4 className="text-sm font-semibold">Questão · {d.curriculum.gradeName} · {d.curriculum.skillCode}</h4>
      {d.supportText && <p className="whitespace-pre-wrap break-words text-sm">{d.supportText}</p>}
      <p className="whitespace-pre-wrap break-words font-medium">{d.statement}</p>
      <p className="text-sm">Escreva apenas o número. Use vírgula ou ponto decimal, sem separador de milhar.</p>
      {d.unit && <p className="break-words text-sm">Unidade da resposta: {d.unit}. Não escreva a unidade no campo.</p>}
      <div className="min-h-16 rounded-lg border border-dashed border-slate-400 p-3 text-sm text-slate-500 dark:border-slate-500 dark:text-slate-400" aria-label="Espaço ilustrativo para resposta">Espaço para resposta · apenas prévia</div>
    </section>
    <details className="rounded-lg bg-slate-100 p-3 text-sm dark:bg-white/5"><summary className="cursor-pointer font-semibold">Conferir a habilidade BNCC</summary><p className="mt-2">{d.curriculum.unitName} — {d.curriculum.skillDescription}</p></details>
    <details open={reviewing || undefined} className="rounded-xl border border-slate-300 p-3 dark:border-white/20"><summary className="cursor-pointer font-semibold">Gabarito e resolução · somente para você</summary>
      <p className="mt-3 break-words font-semibold">Resposta esperada: {d.answer}{d.unit ? ` (${d.unit})` : ''}</p>
      <p className="mt-2 text-sm">A correção exige o valor exato. Vírgula e ponto decimal são aceitos; números próximos não são.</p>
      <h4 className="mt-3 font-semibold">Como chegar à resposta</h4><p className="mt-1 whitespace-pre-wrap break-words text-sm">{d.explanation || 'Você ainda não registrou a resolução. Vale acrescentá-la antes de finalizar a questão.'}</p>
    </details>
    <section className="text-sm"><h4 className="font-semibold">Pontos de conferência</h4><ul className="mt-2 list-disc space-y-2 pl-5">{numericReviewQuestions.map(q => <li key={q}>{q}</li>)}</ul><p className="mt-3 text-slate-600 dark:text-slate-300">{reviewing ? decisionPending ? 'Registre sua decisão abaixo. Apenas abrir esta prévia não aprova a questão.' : 'Este envio já foi concluído. O conteúdo acima preserva a versão recebida.' : d.status==='approved' ? 'Para os estudantes, use a opção Imprimir sem gabarito.' : 'Esta prévia não substitui a revisão da administração.'}</p></section>
  </div>;
}
