const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');
async function runInstitutionalFormsBrowser({ baseUrl, teacher, admin, tokenFor, db, output, mun, school }) {
  assert.equal(process.env.INSTITUTIONAL_FORMS_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output, path.join(root, 'tmp/institutional-forms-qa'));
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = message => { report.inventory.push(message); record(); console.log('Cadastros:', message); };
  let operation = 0;
  async function api(url, user = admin, body) {
    const response = await fetch(baseUrl + '/api' + url, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + tokenFor(user), 'Content-Type': 'application/json', 'Idempotency-Key': 'qa40-institutional-fixture-' + ++operation }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  const longSchool = 'Escola Municipal Conceição de Educação e Desenvolvimento das Comunidades do Campo';
  db.prepare('UPDATE schools SET name=? WHERE public_id=?').run(longSchool, school.publicId);
  for (let i = 0; i < 15; i++) await api('/institutions/management/municipalities', admin, { name: 'Município sintético ' + String(i).padStart(2, '0') });
  if (process.env.INSTITUTIONAL_FORMS_INTERACTIVE === '1') {
    const password = 'Qa40-Release-Only!';
    const credentialsBefore = [teacher, admin].map(user => {
      const original = db.prepare('SELECT id, password, auth_version FROM users WHERE id=?').get(user.id);
      assert.ok(original, 'A conta interativa deve pertencer à fixture sintética');
      return original;
    });
    const connection = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    try {
      for (const user of [teacher, admin]) db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(password, 4), user.id);
      if (fs.existsSync(stop)) fs.unlinkSync(stop);
      fs.writeFileSync(connection, JSON.stringify({ baseUrl, user: admin, teacher, password, token: tokenFor(admin), longSchool }));
      console.log('INSTITUTIONAL_FORMS_INTERACTIVE_READY');
      await new Promise((resolve, reject) => { const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250); const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive expired')); }, 480000); });
    } finally {
      try {
        // Only this disposable fixture may restore a session version. Updating
        // the password fires the security trigger, so restore auth_version last
        // and separately, preserving tokens used by the following API tests.
        db.transaction(() => {
          for (const original of credentialsBefore) {
            db.prepare('UPDATE users SET password=? WHERE id=?').run(original.password, original.id);
            db.prepare('UPDATE users SET auth_version=? WHERE id=?').run(original.auth_version, original.id);
            assert.equal(db.prepare('SELECT COUNT(*) FROM users WHERE id=? AND password=? AND auth_version=?').pluck()
              .get(original.id, original.password, original.auth_version), 1, 'Credenciais sintéticas devem ser restauradas');
          }
        })();
      } finally {
        if (fs.existsSync(connection)) fs.unlinkSync(connection);
        if (fs.existsSync(stop)) fs.unlinkSync(stop);
      }
    }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const forms = p => p.locator('main [data-institutional-forms]').first();
  const modal = p => p.getByRole('dialog', { name: 'Conferir envio institucional' });
  const posts = [];
  async function context(w = 390, h = 664, theme = 'dark', user = admin) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, ...(w < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c); c.setDefaultTimeout(9000);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort());
    await c.route('**/api/announcements/current?*', r => r.fulfill({ json: { announcement: null } }));
    await c.addInitScript(({ baseUrl, theme, user, token }) => { if (location.origin !== baseUrl) return; localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); }, { baseUrl, theme, user, token: tokenFor(user) });
    c.on('page', p => { p.on('pageerror', e => report.pageErrors.push(e.message)); p.on('request', r => { if (r.method() === 'POST' && r.url().includes('/institutions/management/')) posts.push({ url: r.url(), key: r.headers()['idempotency-key'], body: r.postData() }); }); });
    return c;
  }
  async function go(p, adminView = true) {
    await p.goto(baseUrl + '/instituicoes'); await p.waitForLoadState('networkidle');
    if (adminView) await p.getByRole('button', { name: 'Cadastros e turmas', exact: true }).click();
    await expect(forms(p)).toBeVisible(); if (adminView) await expect(p.locator('#institutional-task')).toBeEnabled();
  }
  async function task(p, value) { await p.locator('#institutional-task').selectOption(value); }
  async function choose(p, id, label) { const input = p.locator('#' + id); await input.click(); await p.getByRole('listbox').getByRole('option', { name: label, exact: false }).click(); }
  async function manualMunicipality(p, name) { await task(p, 'municipality'); await p.getByRole('button', { name: 'Incluir manualmente', exact: true }).click(); await p.locator('#municipality-name-manual').fill(name); await p.getByRole('button', { name: 'Salvar município', exact: true }).click(); await expect(modal(p)).toBeVisible(); }
  async function save(p, kind = 'general') {
    await modal(p).getByRole('button', { name: kind === 'teacher' ? 'Confirmar turma' : 'Confirmar e salvar', exact: true }).click();
    await expect(modal(p)).toHaveCount(0); if (kind !== 'teacher') await expect(p.locator('#institutional-task')).toBeEnabled();
  }
  async function capture(p, name) {
    await p.waitForTimeout(100);
    const metrics = await p.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth,
      controls: [...document.querySelectorAll('[data-institutional-forms] button,[data-institutional-forms] input:not([type=checkbox]),[data-institutional-forms] select,[data-institutional-forms] [role=option]')].filter(e => e.getClientRects().length && e.checkVisibility()).map(e => ({ text: e.id || e.textContent, height: e.getBoundingClientRect().height })) }));
    assert.ok(metrics.width <= metrics.viewport + 1, name + ' overflow'); assert.deepEqual(metrics.controls.filter(c => c.height < 43.5), [], name + ' targets');
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' }); report.cases.push({ name, ...metrics }); record();
  }
  try {
    const c = await context(), p = await c.newPage(); await go(p);
    await task(p, 'school'); await expect(p.locator('#school-municipality')).toHaveValue('');
    await task(p, 'class'); await expect(p.locator('#guided-class-membership')).toHaveValue(''); await expect(p.locator('#guided-class-grade')).toHaveValue(''); await expect(p.getByRole('button', { name: 'Preparar e enviar' })).toBeDisabled();
    await manualMunicipality(p, 'Município Água Clara QA40'); const beforeCancel = posts.length;
    await modal(p).getByRole('button', { name: 'Voltar ao formulário' }).click(); assert.equal(posts.length, beforeCancel);
    await task(p, 'school'); await task(p, 'municipality'); await expect(p.locator('#municipality-name-manual')).toHaveValue('Município Água Clara QA40');
    await p.getByRole('button', { name: 'Incluir manualmente', exact: true }).click(); await expect(p.locator('#municipality-name-manual')).toHaveValue('Município Água Clara QA40');
    await p.getByRole('button', { name: 'Salvar município', exact: true }).click(); await save(p);
    const newMun = db.prepare('SELECT public_id FROM municipalities WHERE name=?').get('Município Água Clara QA40');
    await task(p, 'school'); await choose(p, 'school-municipality', 'Município Água Clara QA40'); await p.getByRole('button', { name: 'Incluir manualmente', exact: true }).click();
    await p.locator('#school-name-manual').fill('Escola Municipal QA40'); await p.getByRole('button', { name: 'Salvar escola', exact: true }).click(); await expect(modal(p)).toContainText('Município Água Clara QA40'); await save(p);
    await task(p, 'professional'); await choose(p, 'existing-professional', teacher.name); await choose(p, 'existing-scope-municipality', 'Município Água Clara QA40'); await expect(p.locator('#existing-scope-school')).toHaveValue(''); await choose(p, 'existing-scope-school', 'Escola Municipal QA40');
    await p.getByRole('button', { name: 'Confirmar vínculo', exact: true }).click(); await save(p);
    await task(p, 'class'); await choose(p, 'guided-class-membership', teacher.name + ' Escola Municipal QA40');
    await p.locator('#guided-class-name').fill('7º Ano – manhã QA40'); await choose(p, 'guided-class-grade', '7º Ano - EF'); await p.getByRole('checkbox', { name: 'Matemática', exact: true }).check();
    await p.getByRole('button', { name: 'Preparar e enviar' }).click(); await capture(p, 'class-review'); await save(p);
    await task(p, 'classes'); await expect(forms(p)).toContainText('7º Ano – manhã QA40'); await p.locator('#guided-search').fill('nao existe'); await expect(forms(p)).toContainText('Nenhuma turma nesta busca'); await p.locator('#guided-search').clear();
    const tc = await context(390, 664, 'light', teacher), tp = await tc.newPage(); await go(tp, false);
    await tp.getByRole('button', { name: 'Confirmar turma', exact: true }).click(); await expect(modal(tp)).toContainText('Escola Municipal QA40'); await capture(tp, 'teacher-review'); await save(tp, 'teacher');
    const verified = await api('/institutions/management', teacher); assert.ok(verified.guidedClasses.some(item => item.name === '7º Ano – manhã QA40' && item.migrationStatus === 'verified')); await tc.close();
    check('Ciclo real: município, escola, vínculo, turma e segunda confirmação docente; escolhas explícitas, cancelamento sem POST, rascunhos e busca');
    await task(p, 'professional'); await p.getByRole('button', { name: 'Criar conta', exact: true }).click();
    await p.locator('#new-professional-name').fill('Nova Docente QA40'); await p.locator('#new-professional-email').fill('qa40@example.invalid'); await p.locator('#new-professional-password').fill('Only-Synthetic-40!');
    await choose(p, 'new-scope-municipality', 'Município Água Clara QA40'); await choose(p, 'new-scope-school', 'Escola Municipal QA40');
    await p.getByRole('button', { name: 'Criar e vincular', exact: true }).click(); await expect(modal(p)).not.toContainText('Only-Synthetic'); await capture(p, 'professional-review'); await save(p);
    await expect(p.locator('#new-professional-password')).toHaveValue(''); assert.ok(db.prepare('SELECT id FROM users WHERE email=?').get('qa40@example.invalid'));
    const sensitive = db.prepare("SELECT result_json FROM institutional_write_operations WHERE operation_type='create_professional'").all(); assert.doesNotMatch(JSON.stringify(sensitive), /Only-Synthetic|temporaryPassword|password/);
    check('Nova conta e vínculo atômicos; conferência e recibos sem senha, campo limpo após confirmação');
    await manualMunicipality(p, 'Resposta perdida depois QA40');
    const postsBefore = posts.length;
    await c.route('**/api/institutions/management/municipalities', async r => { await r.fetch(); await r.fulfill({ status: 503, json: { error: 'Resposta perdida sintética' } }); }, { times: 1 });
    await modal(p).getByRole('button', { name: 'Confirmar e salvar' }).dblclick();
    await expect(modal(p).getByRole('button', { name: 'Conferir envio', exact: true })).toBeVisible(); await capture(p, 'uncertain-saved');
    await modal(p).getByRole('button', { name: 'Conferir envio', exact: true }).click(); await expect(modal(p)).toHaveCount(0); assert.equal(posts.length, postsBefore + 1);
    await manualMunicipality(p, 'Resposta perdida antes QA40');
    const retryStart = posts.length;
    await c.route('**/api/institutions/management/municipalities', r => r.abort('failed'), { times: 1 });
    await modal(p).getByRole('button', { name: 'Confirmar e salvar' }).click();
    await modal(p).getByRole('button', { name: 'Conferir envio', exact: true }).click(); await expect(modal(p)).toContainText('Ainda não há confirmação registrada'); await capture(p, 'uncertain-not-saved');
    await modal(p).getByRole('button', { name: 'Repetir o mesmo envio' }).click(); await expect(modal(p)).toHaveCount(0);
    assert.deepEqual(posts.slice(retryStart).map(item => ({ key: item.key, body: item.body })), Array(2).fill({ key: posts[retryStart].key, body: posts[retryStart].body }));
    assert.equal(db.prepare('SELECT count(*) FROM municipalities WHERE name=?').pluck().get('Resposta perdida antes QA40'), 1);
    check('Resposta perdida depois do commit é conferida por GET; antes do commit repete mesma chave/corpo; duplo clique não duplica');
    await manualMunicipality(p, 'Sucesso com consulta falha QA40');
    await c.route('**/api/institutions/management', r => r.fulfill({ status: 503, json: { error: 'Consulta indisponível QA40' } }));
    await modal(p).getByRole('button', { name: 'Confirmar e salvar' }).click(); await expect(modal(p)).toHaveCount(0); await expect(forms(p)).toContainText('Município cadastrado'); await expect(forms(p).getByRole('alert')).toContainText('Consulta indisponível QA40'); await expect(p.locator('#institutional-task')).toBeDisabled(); await capture(p, 'saved-read-failed');
    await c.unroute('**/api/institutions/management'); await forms(p).getByRole('button', { name: 'Tentar novamente' }).click(); await expect(p.locator('#institutional-task')).toBeEnabled();
    await manualMunicipality(p, 'Rejeição sintética QA40');
    await c.route('**/api/institutions/management/municipalities', r => r.fulfill({ status: 409, json: { error: 'Cadastro já existente QA40' } }), { times: 1 });
    await modal(p).getByRole('button', { name: 'Confirmar e salvar' }).click(); await expect(modal(p)).toContainText('Cadastro já existente QA40'); await expect(modal(p).getByRole('button', { name: 'Confirmar e salvar' })).toHaveCount(0); await modal(p).getByRole('button', { name: 'Voltar ao formulário' }).click();
    check('Sucesso continua sucesso se listagem falhar; formulário bloqueado até atualizar, rejeição definida permite corrigir sem reenvio');
    p.on('dialog', d => d.accept());
    await p.getByRole('button', { name: 'Buscar no IBGE', exact: true }).click();
    await c.route('**/api/institutions/management/directories/municipalities?*', r => r.fulfill({ json: { results: [{ name: 'São Bento QA40', uf: 'CE', ibgeCode: '9990040' }] } }));
    await p.locator('#municipality-directory').fill('sao'); await p.getByRole('listbox').getByRole('option', { name: 'São Bento QA40' }).click(); await expect(forms(p)).toContainText('Código IBGE 9990040 preenchido'); await p.getByRole('button', { name: 'Salvar município', exact: true }).click(); await save(p);
    await task(p, 'school'); await choose(p, 'school-municipality', 'São Bento QA40'); await p.getByRole('button', { name: 'Rede municipal · Inep' }).click();
    await c.route('**/api/institutions/management/directories/schools?*', r => r.fulfill({ json: { results: [
      { name: 'Escola já cadastrada QA40', censusCode: '99000001', administrativeDependency: 'municipal', alreadyRegistered: true, operatingStatus: 'active' },
      { name: 'Escola do catálogo QA40', censusCode: '99000002', administrativeDependency: 'municipal', alreadyRegistered: false, operatingStatus: 'active' }], source: { name: 'Inep (fixture sintética)', censusYear: 2025 } } }));
    await p.locator('#school-directory').fill('escola'); await expect(p.getByRole('listbox').getByRole('option', { name: 'Escola já cadastrada QA40' })).toHaveAttribute('aria-disabled', 'true'); await capture(p, 'school-directory'); await p.getByRole('listbox').getByRole('option', { name: 'Escola do catálogo QA40' }).click(); await expect(forms(p)).toContainText('99000002 preenchido'); await p.getByRole('button', { name: 'Salvar escola' }).click(); await save(p);
    await c.close();
    check('Diretórios sintéticos preenchem códigos oficiais; escola duplicada identificada/desabilitada; gravações continuam na API real isolada');
    for (const [w, h] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['light', 'dark']) {
      const mc = await context(w, h, theme), mp = await mc.newPage(); await go(mp);
      const firstField = await mp.locator('#municipality-directory').boundingBox();
      assert.ok(firstField.y >= 108 && firstField.y + firstField.height <= h, 'First field after opening ' + w + theme);
      for (const value of ['municipality', 'school', 'professional', 'class', 'classes']) {
        await task(mp, value); await mp.locator('#institutional-task').scrollIntoViewIfNeeded(); await capture(mp, value + '-' + w + '-' + theme);
      }
      await task(mp, 'professional'); await choose(mp, 'existing-professional', teacher.name); await choose(mp, 'existing-scope-municipality', 'Município de teste'); await choose(mp, 'existing-scope-school', longSchool); await mp.getByRole('button', { name: 'Confirmar vínculo' }).click(); await capture(mp, 'long-review-' + w + '-' + theme);
      const button = modal(mp).getByRole('button', { name: 'Voltar ao formulário' }); await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= h); await button.click();
      await task(mp, 'school'); const input = mp.locator('#school-municipality'); await input.click(); await input.fill('municipio sintetico'); await expect(mp.getByRole('listbox').getByRole('option')).toHaveCount(15);
      for (let n = 0; n < 12; n++) await input.press('ArrowDown');
      const active = await input.getAttribute('aria-activedescendant'), selected = mp.locator('[id="' + active + '"]'); const optionBox = await selected.boundingBox(), listBox = await mp.getByRole('listbox').boundingBox(); assert.ok(optionBox.y >= listBox.y - 1 && optionBox.y + optionBox.height <= listBox.y + listBox.height + 1);
      await capture(mp, 'keyboard-options-' + w + '-' + theme); await input.press('Enter'); await expect(input).toHaveValue('Município sintético 12'); await mc.close();
    }
    check('Três resoluções/dois temas: cinco tarefas, nomes longos, modal inteiro rolável, alvos 44 px, busca sem acento e opção ativa visível por teclado');
    {
      const ec = await context(), ep = await ec.newPage(); const model = await api('/institutions/management');
      await ec.route('**/api/institutions/management', r => r.fulfill({ json: { ...model, municipalities: [], schools: [], memberships: [], teacherMemberships: [], guidedClasses: [] } }));
      await go(ep); await task(ep, 'school'); await expect(forms(ep)).toContainText('Comece cadastrando um município'); await expect(ep.getByRole('button', { name: 'Salvar escola', exact: true })).toBeDisabled();
      await task(ep, 'class'); await expect(forms(ep)).toContainText('Vincule primeiro um professor'); await capture(ep, 'dependencies-empty');
      await ec.unroute('**/api/institutions/management'); await forms(ep).getByRole('button', { name: 'Atualizar cadastros' }).click(); await expect(ep.locator('#institutional-task')).toBeEnabled();
      await ec.route('**/api/institutions/management', r => r.fulfill({ json: { ...model, schools: null } }));
      await forms(ep).getByRole('button', { name: 'Atualizar cadastros' }).click(); await expect(forms(ep).getByRole('alert')).toBeVisible(); await expect(ep.locator('#institutional-task')).toBeDisabled(); await capture(ep, 'invalid-read');
      await ec.unroute('**/api/institutions/management'); await ec.route('**/api/institutions/management', r => r.fulfill({ status: 404, json: { error: 'Piloto indisponível QA40' } }));
      await forms(ep).getByRole('button', { name: 'Tentar novamente' }).click(); await expect(forms(ep)).toContainText('Piloto indisponível QA40'); await expect(ep.locator('#institutional-task')).toHaveCount(0); await capture(ep, 'pilot-disabled'); await ec.close();
    }
    check('Dependências ausentes orientam a sequência; contrato inválido bloqueia novos envios; piloto indisponível remove os formulários');
    {
      const dc = await context(), dp = await dc.newPage(); await go(dp);
      let release, started; const hold = new Promise(resolve => release = resolve), pending = new Promise(resolve => started = resolve);
      await dc.route('**/api/institutions/management/directories/municipalities?*', async r => {
        const query = new URL(r.request().url()).searchParams.get('query');
        if (query === 'antiga') { started(); await hold; }
        await r.fulfill({ json: { results: [{ name: query === 'antiga' ? 'Resultado antigo QA40' : 'Resultado atual QA40', uf: 'CE', ibgeCode: '9990041' }] } }).catch(() => {});
      });
      await dp.locator('#municipality-directory').fill('antiga'); await pending; await dp.locator('#municipality-directory').fill('atual');
      await expect(dp.getByRole('listbox')).toContainText('Resultado atual QA40'); release(); await dp.waitForTimeout(200); await expect(dp.getByRole('listbox')).not.toContainText('Resultado antigo QA40'); await capture(dp, 'directory-stale-discarded');
      await dc.unroute('**/api/institutions/management/directories/municipalities?*');
      await dc.route('**/api/institutions/management/directories/municipalities?*', r => r.fulfill({ status: 503, json: { error: 'Diretório indisponível QA40' } }));
      await dp.locator('#municipality-directory').fill('falha'); await expect(forms(dp)).toContainText('O cadastro manual continua disponível'); await dp.getByRole('button', { name: 'Incluir manualmente' }).click(); await expect(dp.locator('#municipality-name-manual')).toBeEnabled(); await capture(dp, 'directory-manual-fallback'); await dc.close();
    }
    check('Consulta antiga do diretório descartada; indisponibilidade permite inclusão manual sem apagar outro cadastro');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.stack; record(); throw error; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runInstitutionalFormsBrowser };
