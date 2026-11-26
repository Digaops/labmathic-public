import { parseSetDetail } from './questionSetsView.mjs';

function questionLabel(count) { return count === 1 ? 'questão' : 'questões'; }
export function printImageUrl(value, origin) {
  const parts = String(value).split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f]/.test(part))) throw new Error('Caminho de imagem inválido.');
  return new URL('/uploads/' + parts.map(encodeURIComponent).join('/'), origin).href;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatPrintableText(value) {
  return escapeHtml(value).replace(/\n/g, '<br />');
}

function getCorrectOption(question) {
  return question.options?.find((option) => Number(option.is_correct) === 1);
}

function getDevelopmentSpaceClass(value) {
  const classes = {
    small: 'space-small',
    medium: 'space-medium',
    large: 'space-large',
  };

  return classes[value] || '';
}

export function getPrintableDocument(questionSet, showAnswers, appOrigin, deferImages = false) {
  parseSetDetail(questionSet);
  if (!showAnswers && questionSet.is_diagnostic && !questionSet.diagnostic_reviewed) throw new Error('Confirme a revisão antes de imprimir para os alunos.');
  const questions = questionSet?.questions || [];
  const authorCount = questions.filter(question => question.source === 'teacher').length;
  const versionLabel = showAnswers ? 'Versão do professor' : 'Versão dos alunos';
  const printableTitle = escapeHtml(questionSet?.title || 'Simulado');
  const printableDescription = questionSet?.description
    ? `<p class="description">${formatPrintableText(questionSet.description)}</p>`
    : '';

  const questionsHtml = questions.map((question, index) => {
    const optionsHtml = (question.options || []).map((option) => {
      const isCorrect = Number(option.is_correct) === 1;
      const correctClass = showAnswers && isCorrect ? ' option-correct' : '';
      const correctMark = showAnswers && isCorrect ? '<span class="answer-mark">Resposta</span>' : '';

      return `
        <div class="option${correctClass}">
          <span class="option-label">${escapeHtml(option.option_label)})</span>
          <span>${formatPrintableText(option.option_text)}</span>
          ${correctMark}
        </div>
      `;
    }).join('');

    const explanationHtml = showAnswers && question.official_explanation
      ? `
        <div class="explanation">
          <strong>Explicação:</strong> ${formatPrintableText(question.official_explanation)}
        </div>
      `
      : '';
    const imageHtml = question.image_path && Number(question.show_image) !== 0
      ? `<figure class="question-media"><img class="question-image" ${deferImages ? 'data-image-src' : 'src'}="${escapeHtml(printImageUrl(question.image_path, appOrigin))}" alt="Imagem da questão ${index + 1}" /></figure>`
      : '';
    const developmentSpaceClass = getDevelopmentSpaceClass(question.development_space);
    const developmentSpaceHtml = !showAnswers && developmentSpaceClass
      ? `<div class="development-space ${developmentSpaceClass}"></div>`
      : '';

    return `
      <section class="question">
        <div class="question-meta">
          <span>Questão ${index + 1}</span>
          ${question.question_code ? `<span>${escapeHtml(question.question_code)}</span>` : ''}
          ${question.skill_code ? `<span>${escapeHtml(question.skill_code)}</span>` : ''}
          ${question.source === 'teacher' ? '<span>Questão criada pelo professor</span>' : ''}
        </div>

        <div class="${imageHtml ? 'question-content has-media' : 'question-content'}">
          <div class="question-text">
            <div class="statement">${formatPrintableText(question.statement)}</div>
            ${question.support_text ? `<div class="support">${formatPrintableText(question.support_text)}</div>` : ''}
            ${developmentSpaceHtml}
          </div>
          ${imageHtml}
        </div>

        <div class="options">${optionsHtml}</div>

        ${explanationHtml}
      </section>
    `;
  }).join('');

  const answerKeyHtml = showAnswers
    ? `
      <section class="answer-key">
        <h2>Gabarito</h2>
        <div class="answer-grid">
          ${questions.map((question, index) => {
            const correct = getCorrectOption(question);
            return `
              <div>
                <strong>${index + 1}.</strong>
                ${correct ? escapeHtml(correct.option_label) : '-'}
              </div>
            `;
          }).join('')}
        </div>
      </section>
    `
    : '';

  const studentFieldsHtml = showAnswers
    ? ''
    : `
      <div class="student-fields">
        <span>Nome: ________________________________________________</span>
        <span>Turma: ____________________</span>
        <span>Data: ____/____/________</span>
      </div>
    `;

  return `<!doctype html>
    <html lang="pt-BR">
      <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${printableTitle} - ${versionLabel}</title>
        <style>
          @page {
            size: A4;
            margin: 14mm;
          }

          * {
            box-sizing: border-box;
            overflow-wrap: anywhere;
          }

          body {
            max-width: 794px;
            padding: 16px;
            margin: 0 auto;
            color: #111827;
            background: #ffffff;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 11pt;
            line-height: 1.45;
          }

          header {
            border-bottom: 2px solid #1A73E8;
            padding-bottom: 12px;
            margin-bottom: 18px;
          }

          h1 {
            margin: 0 0 6px;
            font-size: 20pt;
            line-height: 1.15;
          }

          h2 {
            margin: 0 0 10px;
            font-size: 14pt;
          }

          .version {
            display: inline-block;
            margin-bottom: 8px;
            border: 1px solid #bfdbfe;
            border-radius: 999px;
            background: #eff6ff;
            color: #1d4ed8;
            padding: 4px 10px;
            font-size: 9pt;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: .04em;
          }

          .description {
            margin: 8px 0 0;
            color: #4b5563;
          }

          .meta,
          .student-fields {
            display: flex;
            flex-wrap: wrap;
            gap: 10px 18px;
            color: #4b5563;
            font-size: 10pt;
          }

          .student-fields {
            margin-top: 16px;
            color: #111827;
          }

          .question {
            break-inside: avoid;
            page-break-inside: avoid;
            border: 1px solid #d1d5db;
            border-left: 4px solid #1A73E8;
            border-radius: 8px;
            padding: 14px;
            margin-bottom: 14px;
          }

          .question-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 10px;
          }

          .question-meta span {
            border-radius: 6px;
            background: #eff6ff;
            color: #1d4ed8;
            padding: 3px 7px;
            font-size: 9pt;
            font-weight: 700;
          }

          .statement {
            white-space: normal;
          }

          .question-content {
            display: block;
          }

          .question-content.has-media {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(38mm, 55mm);
            gap: 12px;
            align-items: start;
          }

          .question-text {
            min-width: 0;
          }

          .support {
            margin-top: 10px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            background: #f9fafb;
            padding: 10px;
            color: #374151;
          }

          .question-media {
            margin: 0;
            display: flex;
            width: 100%;
            align-self: start;
            justify-self: end;
            justify-content: flex-end;
          }

          .question-image {
            display: block;
            width: auto;
            height: auto;
            max-width: 55mm;
            max-height: 70mm;
            object-fit: contain;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            background: #ffffff;
          }

          .development-space {
            margin-top: 12px;
            background: transparent;
            overflow: hidden;
          }

          .space-small {
            min-height: 20mm;
          }

          .space-medium {
            min-height: 36mm;
          }

          .space-large {
            min-height: 56mm;
          }

          .options {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 8px;
            margin-top: 12px;
          }

          .option {
            position: relative;
            min-height: 34px;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            padding: 8px 10px;
          }

          .option-label {
            font-weight: 700;
            margin-right: 6px;
          }

          .option-correct {
            border-color: #22c55e;
            background: #f0fdf4;
            color: #166534;
          }

          .answer-mark {
            float: right;
            margin-left: 8px;
            border-radius: 999px;
            background: #22c55e;
            color: white;
            padding: 2px 7px;
            font-size: 8pt;
            font-weight: 700;
          }

          .explanation {
            margin-top: 12px;
            border: 1px solid #bfdbfe;
            border-radius: 8px;
            background: #eff6ff;
            color: #1e40af;
            padding: 10px;
          }

          .answer-key {
            break-inside: avoid;
            page-break-inside: avoid;
            margin-top: 14px;
            border-top: 2px solid #1A73E8;
            padding-top: 14px;
          }

          .answer-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 8px;
          }

          .answer-grid div {
            border: 1px solid #d1d5db;
            border-radius: 8px;
            padding: 8px;
          }

          @media print {
          body { max-width: none; padding: 0; margin: 0; }
          .print-tools { display: none !important; }
          .option, .question-media { break-inside: avoid; }
          .question-meta { break-after: avoid; }
            .question {
              box-shadow: none;
            }

            .question-content.has-media {
              display: grid;
              grid-template-columns: minmax(0, 1fr) minmax(38mm, 55mm);
              gap: 12px;
              align-items: start;
            }

            .question-media {
              justify-content: flex-end;
            }
          }

          @media screen and (max-width: 720px) {
            .question-content.has-media {
              grid-template-columns: 1fr;
            }

            .question-media {
              justify-content: center;
            }

            .options,
            .answer-grid {
              grid-template-columns: 1fr;
            }
          }
        .print-tools { padding: 12px; margin-bottom: 16px; border: 1px solid #cbd5e1; background: #f8fafc; font-size: 14px; }
        .print-tools button { min-height: 44px; margin: 4px; padding: 8px 12px; border: 1px solid #64748b; border-radius: 8px; background: white; color: #0f172a; font: inherit; cursor: pointer; }
        .print-tools button:disabled { opacity: .55; cursor: wait; }
        .print-tools button:focus-visible { outline: 3px solid #0284c7; outline-offset: 2px; }
        .question.long-question { break-inside: auto; page-break-inside: auto; }
        .print-measure { position: absolute; left: -100000px; top: 0; visibility: hidden; pointer-events: none; width: 182mm; }
        .print-measure .question-content.has-media { display: grid; grid-template-columns: minmax(0, 1fr) minmax(38mm, 55mm); gap: 12px; }
        .print-measure .question-media { justify-content: flex-end; }
        .print-measure .options { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
        </style>
      </head>
      <body>
      <div class="print-tools" aria-label="Controles da prévia"><p id="print-status" role="status">Carregando imagens e fontes…</p><button id="print-button" disabled>Imprimir / salvar PDF</button><button id="print-retry" hidden>Tentar carregar imagens</button><button id="print-close">Fechar prévia</button></div>
        <header>
          <span class="version">${versionLabel}</span>
          <h1>${printableTitle}</h1>
        ${questionSet.is_diagnostic && !questionSet.diagnostic_reviewed ? '<p>Rascunho — revisão pendente. Confira antes de usar com a turma.</p>' : ''}
          <div class="meta">
            <span>${questions.length} ${questionLabel(questions.length)}</span>
            ${authorCount ? `<span>${authorCount} ${authorCount === 1 ? 'questão criada por professor' : 'questões criadas por professores'}</span>` : ''}
            ${questionSet?.created_at ? `<span>Criado em ${new Date(questionSet.created_at).toLocaleDateString('pt-BR')}</span>` : ''}
            ${questionSet?.user_name ? `<span>Professor: ${escapeHtml(questionSet.user_name)}</span>` : ''}
          </div>
          ${printableDescription}
          ${studentFieldsHtml}
        </header>

        <main>
          ${questionsHtml}
          ${answerKeyHtml}
        </main>
      </body>
    </html>`;
}


export function openQuestionSetPrint(questionSet, showAnswers) {
  const html = getPrintableDocument(questionSet, showAnswers, window.location.origin, true);
  const preview = window.open('', '_blank');
  if (!preview) throw new Error('A prévia não abriu. Permita pop-ups deste site e tente novamente.');
  try {
    preview.document.write(html); preview.document.close();
    preview.opener = null;
    const doc = preview.document;
    const status = doc.getElementById('print-status'), button = doc.getElementById('print-button'), retry = doc.getElementById('print-retry');
    let attempt = 0, controller;
    const urls = new Set();
    function release() {
      controller?.abort();
      for (const url of urls) preview.URL.revokeObjectURL(url);
      urls.clear();
    }
    async function prepare() {
      release();
      controller = new AbortController();
      const current = ++attempt;
      button.disabled = true; retry.hidden = true;
      status.setAttribute('role', 'status'); status.textContent = 'Carregando imagens e fontes…';
      let timer;
      try {
        const images = Array.from(doc.images);
        await Promise.race([
          Promise.all([doc.fonts?.ready, ...images.map(async img => {
            // Fetch through the authenticated source page, then give the preview its own resource.
            const response = await fetch(img.dataset.imageSrc, { credentials: 'same-origin', signal: controller.signal });
            if (!response.ok) throw new Error('Imagem indisponível.');
            const blob = await response.blob();
            if (!blob.type.startsWith('image/')) throw new Error('Resposta de imagem inválida.');
            if (preview.closed || current !== attempt) return;
            const url = preview.URL.createObjectURL(blob); urls.add(url); img.src = url;
            await img.decode();
          })]),
          new Promise((_, reject) => { timer = preview.setTimeout(() => { controller.abort(); reject(new Error('Recursos demoraram para carregar.')); }, 15000); }),
        ]);
        if (preview.closed || current !== attempt) return;
        if (images.some(img => !img.complete || img.naturalWidth === 0)) throw new Error('Imagem não carregada.');
        // Measure with A4's usable width; small-screen CSS must not decide printed page breaks.
        const measure = doc.createElement('div'); measure.className = 'print-measure'; measure.setAttribute('aria-hidden', 'true');
        const originals = Array.from(doc.querySelectorAll('main > .question'));
        const clones = originals.map(question => question.cloneNode(true));
        measure.append(...clones); doc.body.append(measure);
        try {
          await Promise.all(Array.from(measure.querySelectorAll('img')).map(img => img.decode()));
          if (preview.closed || current !== attempt) return;
          clones.forEach((clone, index) => originals[index].classList.toggle('long-question', clone.getBoundingClientRect().height > 269 * 96 / 25.4));
        } finally { measure.remove(); }
        button.disabled = false; status.textContent = 'Prévia pronta. Confira o conteúdo antes de imprimir.';
      } catch {
        if (preview.closed || current !== attempt) return;
        release();
        status.setAttribute('role', 'alert');
        status.textContent = 'Não foi possível carregar todas as imagens ou fontes. Para evitar uma prova incompleta, a impressão continua bloqueada.';
        retry.hidden = false;
      } finally { if (!preview.closed) preview.clearTimeout(timer); }
    }
    button.addEventListener('click', () => { if (!button.disabled && !preview.closed) { preview.focus(); preview.print(); } });
    retry.addEventListener('click', () => prepare());
    doc.getElementById('print-close').addEventListener('click', () => preview.close());
    preview.addEventListener('pagehide', () => { attempt++; release(); }, { once: true });
    void prepare();
    return preview;
  } catch (error) { preview.close(); throw error; }
}
