const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const { expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

// Reusable from the isolated layout fixture or a browser REPL. Never targets a
// deployed host; each case owns a fresh module cache and closes its own context.
async function runPlannerResourceBrowser({ browser, baseUrl, teacher, token, planId, materialTitle }) {
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(teacher?.role, 'professor');
  assert.ok(token && planId && materialTitle);
  const cases = [];
  for (const chunk of ['PlannerResourcePreview', 'PDFViewer']) {
    for (const scope of ['editor', 'picker']) {
      const context = await browser.newContext({ viewport: { width: 1024, height: 700 }, serviceWorkers: 'block' });
      context.setDefaultTimeout(8000);
      try {
        await context.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
        let abortedChunks = 0;
        await context.route(`**/assets/${chunk}-*.js`, route => { abortedChunks++; return route.abort('failed'); });
        await context.addInitScript(({ origin, user, auth }) => {
          if (location.origin === origin) {
            localStorage.setItem('theme', 'dark');
            if (!sessionStorage.getItem('planner_resource_qa_seeded')) {
              sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token: auth }));
              sessionStorage.setItem('planner_resource_qa_seeded', '1');
            }
          }
        }, { origin: baseUrl, user: teacher, auth: token });
        const page = await context.newPage();
        let documentRequests = 0;
        page.on('request', request => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++;
        });
        const editor = page.locator('[data-planner-editor]');
        const note = editor.getByLabel('Observações do professor', { exact: true });
        const consultation = page.getByRole('dialog', { name: 'Consultar recurso', exact: true });
        const picker = page.getByRole('dialog', { name: 'Recursos da aula', exact: true });
        const guard = page.getByRole('dialog', { name: 'Sair sem salvar?', exact: true });
        const endpoint = baseUrl + '/api/lesson-plans/' + encodeURIComponent(planId);
        const originalResponse = await context.request.get(endpoint, { headers: { Authorization: 'Bearer ' + token } });
        assert.equal(originalResponse.status(), 200);
        const original = (await originalResponse.json()).plan;
        assert.equal(original.status, 'draft', 'o ensaio deve começar em um plano sintético ainda rascunho');
        const originalResources = original.lessons[0].resources.map(resource => ({
          type: resource.type, title: resource.title, notes: resource.notes,
          materialId: resource.materialId, questionId: resource.questionId, questionSetId: resource.questionSetId,
        }));
        await page.goto(baseUrl + '/planejamento/' + encodeURIComponent(planId));
        await page.waitForLoadState('networkidle');
        const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
        if (await notice.isVisible()) await notice.click();
        await expect(note).toBeVisible();
        await expect(editor.getByRole('heading', { name: 'Editar planejamento', exact: true })).toBeVisible();
        const noteNode = await note.elementHandle();
        const originalNote = await note.inputValue();
        const pendingNote = `${originalNote}\nNota preservada após falha ${chunk} no ${scope}.`;
        await note.fill(pendingNote);
        let choice;
        if (scope === 'picker') {
          await editor.getByRole('button', { name: 'Escolher recursos da aula', exact: true }).click();
          choice = picker.getByRole('checkbox').nth(1);
          await expect(choice).not.toBeChecked();
          await choice.check();
          await picker.getByRole('button', { name: 'Ver recurso: ' + materialTitle, exact: true }).click();
        } else {
          await editor.getByRole('button', { name: 'Ver recurso: ' + materialTitle, exact: true }).click();
        }
        await expect(consultation.getByRole('alert')).toContainText('Não foi possível carregar a consulta.');
        assert.ok(abortedChunks > 0, `${chunk}: o chunk de produção precisa ter sido realmente bloqueado`);
        assert.equal(documentRequests, 1, 'a falha local não pode recarregar a página');
        assert.equal(await noteNode.evaluate(element => element.isConnected), true, 'o editor original não pode ser desmontado');
        await consultation.getByRole('button', { name: 'Fechar consulta', exact: true }).click();
        await expect(consultation).toHaveCount(0);
        if (scope === 'picker') {
          await expect(choice).toBeChecked();
          await expect(picker.getByRole('button', { name: 'Ver recurso: ' + materialTitle, exact: true })).toBeFocused();
          // Discard only the extra unconfirmed selection, never mutate the
          // caller's resource fixture or confuse it with the editor's note.
          await picker.getByRole('button', { name: 'Cancelar', exact: true }).click();
          await expect(guard).toBeVisible();
          await guard.getByRole('button', { name: 'Ficar nesta tela', exact: true }).click();
          await expect(choice).toBeChecked();
          await picker.getByRole('button', { name: 'Cancelar', exact: true }).click();
          await guard.getByRole('button', { name: 'Sair sem salvar', exact: true }).click();
          await expect(picker).toHaveCount(0);
        }
        await expect(note).toHaveValue(pendingNote);
        await editor.getByRole('button', { name: 'Voltar aos planejamentos', exact: true }).click();
        await expect(guard).toBeVisible();
        await guard.getByRole('button', { name: 'Ficar nesta tela', exact: true }).click();
        await expect(guard).toHaveCount(0);
        await expect(note).toHaveValue(pendingNote);
        await expect(page).toHaveURL(baseUrl + '/planejamento/' + planId);
        async function saveAndConfirm(expectedNote) {
          const responseReady = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'PUT');
          await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
          const response = await responseReady;
          assert.equal(response.status(), 200);
          const saved = (await response.json()).plan;
          assert.equal(saved.status, 'draft');
          assert.equal(saved.lessons[0].teacherNotes, expectedNote.trim() || null);
          assert.deepEqual(saved.lessons[0].resources.map(resource => ({
            type: resource.type, title: resource.title, notes: resource.notes,
            materialId: resource.materialId, questionId: resource.questionId, questionSetId: resource.questionSetId,
          })), originalResources);
          await expect(editor.getByRole('status')).toContainText('Rascunho salvo');
          await expect(note).toHaveValue(expectedNote);
          await expect(editor.getByText('Alterações não salvas', { exact: false })).toHaveCount(0);
        }
        await saveAndConfirm(pendingNote);
        await note.fill(originalNote);
        await saveAndConfirm(originalNote);
        assert.equal(documentRequests, 1, 'salvar/restaurar não pode contornar a falha com uma recarga');
        assert.equal(await noteNode.evaluate(element => element.isConnected), true);
        cases.push({ chunk, scope, abortedChunks, localFallback: true, editorPreserved: true,
          selectionPreserved: scope === 'picker', navigationGuardPreserved: true, saved: true, originalRestored: true });
      } finally { await context.close(); }
    }
  }
  return { status: 'passed', syntheticDataOnly: true, cases };
}

module.exports = { runPlannerResourceBrowser };
