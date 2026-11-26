import { createNumericPrintWindow } from './numericDraftPrint.mjs';

const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const paragraph = value => `<p>${escape(value)}</p>`;

export function parseNumericAssessmentPaper(value, expected) {
  const a = value?.assessment;
  if (value?.kind !== 'numeric-assessment-paper-v1' || value.audience !== expected.audience
    || !['student', 'teacher'].includes(value.audience) || !digest(value.fingerprint)
    || a?.id !== expected.assessmentId || value.schoolClass?.id !== expected.classId
    || !Number.isSafeInteger(a.revision) || a.revision < 1
    || (expected.revision !== undefined && a.revision !== expected.revision)
    || (expected.fingerprint !== undefined && value.fingerprint !== expected.fingerprint)
    || !text(a.title, 200, true) || !text(a.instructions, 5000) || !text(value.schoolClass.name, 200, true)
    || !['draft', 'scheduled', 'open', 'closed'].includes(a.status) || typeof a.randomizeQuestions !== 'boolean'
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100 || value.items.length !== a.questionCount
    || value.items.some((item, index) => !item || item.number !== index + 1 || !text(item.code, 100, true)
      || !text(item.skillCode, 100) || !text(item.statement, 10000, true) || !text(item.supportText, 10000) || !text(item.unit, 100)
      || (value.audience === 'student' ? ('answer' in item || 'explanation' in item || 'answerKey' in item)
        : !text(item.answer, 20, true) || !/^-?\d{1,9}(?:,\d{1,6})?$/.test(item.answer) || !text(item.explanation, 5000)))) {
    throw new Error('A cópia não corresponde à atividade conferida. Atualize a prévia.');
  }
  return value;
}

function documentShell(content = '', teacher = false, ready = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
    <meta name="referrer" content="no-referrer"><title>LabMathic · ${teacher ? 'Gabarito do professor' : 'Atividade em papel'}</title><style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; overflow-wrap: anywhere; }
    body { max-width: 180mm; margin: auto; padding: 16px; font: 12pt/1.5 Arial, sans-serif; color: #172033; background: white; }
    body.large-text { font-size: 14pt; } h1 { font-size: 1.5em; } h2 { font-size: 1.1em; }
    h1, h2 { line-height: 1.3; break-after: avoid; margin: 8px 0; } p { white-space: pre-wrap; margin: 8px 0; orphans: 3; widows: 3; }
    header { border-bottom: 2px solid #334155; padding-bottom: 12px; } section { margin-top: 22px; }
    .answer-space { min-height: 25mm; border: 1px solid #64748b; padding: 8px; margin: 12px 0; break-inside: avoid; }
    .reference, footer { font-size: .85em; } footer { border-top: 1px solid #64748b; margin-top: 20px; padding-top: 8px; }
    .tools { border: 1px solid #64748b; padding: 12px; margin-bottom: 16px; } .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button, label { min-height: 44px; font: inherit; } button { padding: 8px 12px; border: 1px solid #475569; border-radius: 6px; background: white; color: #172033; cursor: pointer; }
    label { display: flex; align-items: center; gap: 8px; margin-top: 8px; } input { width: 20px; height: 20px; }
    button:focus-visible, input:focus-visible { outline: 3px solid #0369a1; outline-offset: 3px; }
    @media print { body { max-width: none; padding: 0; } .tools { display: none !important; } }
    </style></head><body><div class="tools" aria-label="Controles da impressão">
    <p id="numeric-print-status" role="status">${ready ? teacher ? 'Gabarito do professor. Não entregar aos estudantes.' : 'Cópia do estudante, sem gabarito. Confira as páginas antes de imprimir.' : 'Conferindo a atividade salva…'}</p>
    <div class="actions"><button id="numeric-print-button"${ready ? '' : ' disabled'}>Imprimir / salvar PDF</button><button id="numeric-print-close">Fechar cópia</button></div>
    <label><input id="numeric-print-large" type="checkbox"${ready ? '' : ' disabled'}>Usar texto maior</label>
    <p>Esta cópia será fechada ao sair da prévia ou atualizar a atividade.</p></div>${content}</body></html>`;
}

export function numericAssessmentPaperDocument(value, expected) {
  const p = parseNumericAssessmentPaper(value, expected), teacher = p.audience === 'teacher';
  const reference = `${p.assessment.id.slice(0, 8)} · Revisão ${p.assessment.revision} · ${p.fingerprint.slice(0, 12)}`;
  const items = p.items.map(item => `<section><h2>Questão ${item.number} · ${escape(item.code)}</h2>${item.supportText ? paragraph(item.supportText) : ''}
    ${teacher ? `${paragraph(item.statement)}<p><strong>Resposta: ${escape(item.answer)}${item.unit ? ` (${escape(item.unit)})` : ''}</strong></p>
    ${paragraph(item.explanation || 'Resolução não registrada. Confira o procedimento antes da correção.')}${paragraph(item.skillCode)}`
    : `${paragraph(item.statement)}${item.unit ? paragraph(`Unidade da resposta: ${item.unit}`) : ''}<div class="answer-space">Resposta:</div>`}</section>`).join('');
  return documentShell(`<header><p><strong>${teacher ? 'GABARITO · SOMENTE PARA O PROFESSOR' : 'LabMathic · Atividade em papel'}</strong></p>
    <h1>${escape(p.assessment.title)}</h1>${paragraph(p.schoolClass.name)}
    ${teacher ? '<p>Não entregar esta cópia aos estudantes. A correção exige o valor exato; vírgula e ponto decimal são equivalentes.</p>'
    : '<p>Nome: __________________________________________________</p><p>Data: ____________________</p><p>Escreva apenas o número na resposta. Você pode usar vírgula ou ponto decimal. Não use separador de milhar.</p>'}
    ${!teacher && p.assessment.instructions ? paragraph(p.assessment.instructions) : ''}<p class="reference">Referência: ${escape(reference)}</p></header>
    <main>${items}</main><footer>${paragraph(`${p.items.length} ${p.items.length === 1 ? 'questão' : 'questões'} · Referência: ${reference}`)}</footer>`, teacher, true);
}

export function createNumericAssessmentPrintPreview(openWindow, lifecycleTarget) {
  return createNumericPrintWindow(numericAssessmentPaperDocument, documentShell(), openWindow, lifecycleTarget);
}
