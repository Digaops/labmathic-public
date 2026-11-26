import { numericReviewQuestions, parseNumericPreview } from './numericDraftView.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const paragraph = value => `<p>${escape(value)}</p>`;
function shell(content = '', ready = false, student = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
    <meta name="referrer" content="no-referrer"><title>LabMathic - ${student ? 'Atividade em papel' : 'Conferência de rascunho'}</title><style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; overflow-wrap: anywhere; }
    body { max-width: 180mm; margin: 0 auto; padding: 16px; font: 12pt/1.5 Arial, sans-serif; color: #172033; background: #fff; }
    body.large-text { font-size: 14pt; }
    h1 { font-size: 1.5em; margin: 6px 0; } h2 { font-size: 1.15em; margin: 0 0 8px; }
    h1, h2, h3 { break-after: avoid; line-height: 1.3; }
    p { white-space: pre-wrap; margin: 8px 0; orphans: 3; widows: 3; }
    section { margin-top: 20px; } header { border-bottom: 2px solid #334155; padding-bottom: 12px; }
    .notice { border-left: 3px solid #475569; padding: 4px 10px; }
    .answer-space { min-height: 20mm; border: 1px solid #64748b; margin: 12px 0; padding: 8px; break-inside: avoid; }
    .teacher-key { border-top: 2px solid #475569; padding-top: 12px; }
    .tools { border: 1px solid #94a3b8; padding: 12px; margin-bottom: 16px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button, label { font: inherit; min-height: 44px; } button { cursor: pointer; background: #fff; color: #172033; border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; }
    button:focus-visible, input:focus-visible { outline: 3px solid #0369a1; outline-offset: 3px; }
    label { display: flex; align-items: center; gap: 8px; padding-top: 8px; } input { width: 20px; height: 20px; }
    li { margin: 6px 0; } footer { border-top: 1px solid #94a3b8; margin-top: 20px; padding-top: 8px; font-size: .85em; }
    @media print { body { max-width: none; padding: 0; } .tools { display: none !important; } }
    </style></head><body><div class="tools" aria-label="Controles da impressão">
    <p id="numeric-print-status" role="status">${ready ? student ? 'Cópia do estudante, sem gabarito. Confira antes de imprimir.' : 'Cópia do professor com gabarito. Não entregar aos estudantes.' : 'Conferindo a versão salva…'}</p>
    <div class="actions"><button id="numeric-print-button"${ready ? '' : ' disabled'}>Imprimir / salvar PDF</button><button id="numeric-print-close">Fechar cópia</button></div>
    <label><input id="numeric-print-large" type="checkbox"${ready ? '' : ' disabled'}>Usar texto maior</label>
    <p>Esta cópia não se atualiza sozinha. Ela será fechada ao voltar à edição ou sair do rascunho.</p></div>${content}</body></html>`;
}
export function getNumericDraftPrintDocument(value, expectedId, expectedRevision, audience = 'teacher') {
  const { draft: d } = parseNumericPreview(value, expectedId, expectedRevision);
  if (!['teacher','student'].includes(audience) || (audience === 'student' && d.status !== 'approved')) throw new Error('numeric_approval_required');
  if (audience === 'student') return shell(`<header><p>LabMathic · Atividade em papel</p><h1>Questão de resposta numérica</h1>
    ${paragraph(d.curriculum.gradeName)}<p>Nome: __________________________________________________</p><p>Turma: ____________________ Data: ____________________</p></header>
    <main><section><h2>Questão</h2>${d.supportText ? paragraph(d.supportText) : ''}${paragraph(d.statement)}
    ${paragraph('Escreva apenas o número. Use vírgula ou ponto decimal, sem separador de milhar.')}
    ${d.unit ? paragraph(`Unidade da resposta: ${d.unit}. Não escreva a unidade no campo.`) : ''}
    <div class="answer-space">Resposta:</div></section></main><footer>${paragraph(`LabMathic · ${d.curriculum.skillCode} · Versão ${d.version || 1}`)}</footer>`, true, true);
  return shell(`<header><p><strong>${d.status === 'approved' ? 'VERSÃO APROVADA - CÓPIA DO PROFESSOR' : 'RASCUNHO - CONFERÊNCIA DO PROFESSOR'}</strong></p><h1>Questão de resposta numérica</h1>
    ${paragraph(`${d.curriculum.gradeName} · ${d.curriculum.unitName} · ${d.curriculum.skillCode}`)}
    ${paragraph(d.curriculum.skillDescription)}<p class="notice">${d.status === 'approved' ? 'Esta cópia contém o gabarito. Para os estudantes, use a cópia sem gabarito.' : 'Não aplicar à turma. Esta cópia contém o gabarito e não representa aprovação editorial.'}</p></header>
    <main><section aria-label="Prévia da questão"><h2>Questão</h2>${d.supportText ? paragraph(d.supportText) : ''}${paragraph(d.statement)}
    ${paragraph('Escreva apenas o número. Use vírgula ou ponto decimal, sem separador de milhar.')}
    ${d.unit ? paragraph(`Unidade da resposta: ${d.unit}. Não escreva a unidade no campo.`) : ''}
    <div class="answer-space">Resposta:</div></section>
    <section class="teacher-key"><h2>Gabarito - somente para o professor</h2>${paragraph(`Resposta esperada: ${d.answer}${d.unit ? ` (${d.unit})` : ''}`)}
    ${paragraph('Correção exata: 2,5 e 2.50 representam o mesmo valor. Um número próximo não será aceito.')}
    <h3>Como chegar à resposta</h3>${paragraph(d.explanation || 'Resolução ainda não registrada. Vale acrescentá-la antes de finalizar a questão.')}</section>
    <section><h2>Antes de finalizar</h2><ul>${numericReviewQuestions.map(q => `<li>${escape(q)}</li>`).join('')}</ul></section></main>
    <footer>${paragraph(`${d.code} · Revisão ${d.revision}`)}${paragraph('Cópia privada do professor. Não enviar a estudantes. A preparação não aplica esta questão on-line.')}</footer>`, true);
}

// Reserve a blank window during the click; populate only after server validation and strict audit.
export function createNumericDraftPrintPreview(openWindow = () => window.open('', '_blank'), lifecycleTarget = typeof window === 'undefined' ? null : window) {
  return createNumericPrintWindow(getNumericDraftPrintDocument, shell(), openWindow, lifecycleTarget);
}

export function createNumericPrintWindow(documentBuilder, loadingDocument, openWindow = () => window.open('', '_blank'), lifecycleTarget = typeof window === 'undefined' ? null : window) {
  const preview = openWindow();
  if (!preview) throw new Error('numeric_popup_blocked');
  let active = true;
  const close = () => {
    active = false; lifecycleTarget?.removeEventListener('pagehide', close);
    try { if (!preview.closed) preview.close(); } catch { /* Already detached. */ }
  };
  function install(html, ready) {
    preview.document.open(); preview.document.write(html); preview.document.close();
    const doc = preview.document;
    doc.getElementById('numeric-print-close').addEventListener('click', close);
    if (ready) {
      doc.getElementById('numeric-print-large').addEventListener('change', event => doc.body.classList.toggle('large-text', event.target.checked));
      doc.getElementById('numeric-print-button').addEventListener('click', () => {
        if (!active || preview.closed) return;
        try { preview.focus(); preview.print(); }
        catch { doc.getElementById('numeric-print-status').textContent = 'Use o comando Imprimir do navegador e escolha Salvar como PDF, se desejar.'; }
      });
    }
  }
  try { lifecycleTarget?.addEventListener('pagehide', close); preview.opener = null; install(loadingDocument, false); }
  catch (error) { close(); throw error; }
  return { close, render(...args) {
    if (!active || preview.closed) throw new Error('numeric_preview_closed');
    try { install(documentBuilder(...args), true); preview.focus(); }
    catch (error) { close(); throw error; }
  } };
}
