const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runPublicAccessBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, materialId, share, db, output }) {
  assert.equal(process.env.PUBLIC_ACCESS_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output, path.join(root, 'tmp/public-access-qa'));
  const config = require('../../src/config'); assert.equal(config.smtp.user, ''); assert.equal(config.smtp.pass, '');
  const report = { status: 'running', syntheticDataOnly: true, cases: [], inventory: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Acesso público:', description); };
  const password = 'Public-fixture-only-9!', nextPassword = 'New-public-fixture-9!';
  const bcrypt = require('bcryptjs');
  for (const user of [previewUser, admin]) db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(password, 4), user.id);
  function resetLink({ expired = false, used = false } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO password_reset_tokens(user_id,token,expires_at,used) VALUES (?,?,?,?)')
      .run(previewUser.id, 'sha256:' + crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + (expired ? -60000 : 3600000)).toISOString(), Number(used));
    return token;
  }
  function shareMaterial(id) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO share_links(material_id,created_by,token,expires_at) VALUES (?,?,?,?)').run(id, admin.id, token, new Date(Date.now() + 3600000).toISOString());
    return token;
  }
  function material(title, icon, file = null, external = null) {
    const type = Number(db.prepare('INSERT INTO material_types(name,icon) VALUES (?,?)').run(title, icon).lastInsertRowid);
    const id = Number(db.prepare('INSERT INTO materials(title,description,material_type_id,file_path,external_url,created_by) VALUES (?,?,?,?,?,?)')
      .run(title, 'Orientações para a aula. '.repeat(25), type, file, external, admin.id).lastInsertRowid);
    return { id, token: shareMaterial(id), title };
  }
  fs.copyFileSync(path.join(root, 'client/public/logos/logo-labmathic-mark.png'), path.join(config.uploadDir, 'public-image.png'));
  const variants = {
    image: material('Imagem para conversar com a turma', 'image', 'public-image.png'),
    document: material('Orientações de aula em documento', 'document', 'layout-fixture.pdf'),
    external: material('Atividade em outro site', 'document', null, 'https://example.org/aula'),
    youtube: material('Vídeo para discutir estratégias', 'video', null, 'https://www.youtube.com/watch?v=abcdefghijk'),
    video: material('Vídeo local de teste', 'video', 'public-video.webm'),
    missing: material('Material aguardando arquivo', 'image'),
    unsafe: material('Endereço não permitido', 'video', 'https://example.org/private.pdf', 'javascript:alert(1)'),
  };
  const validReset = resetLink();
  if (process.env.PUBLIC_ACCESS_INTERACTIVE === '1') {
    const pdfOutput = path.join(root, 'tmp/pdfs/public-access-review'); fs.mkdirSync(pdfOutput, { recursive: true });
    fs.copyFileSync(path.join(config.uploadDir, 'layout-fixture.pdf'), path.join(pdfOutput, 'shared-fixture.pdf'));
    const connection = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(connection, JSON.stringify({ baseUrl, resetToken: validReset, shareToken: share.token, variants }));
    console.log('PUBLIC_ACCESS_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => { const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250); const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive expired')); }, 480000); }); }
    finally { if (fs.existsSync(connection)) fs.unlinkSync(connection); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  async function context(width = 1024, height = 600, theme = 'light') {
    const c = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    contexts.push(c); c.setDefaultTimeout(8000);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort());
    await c.addInitScript(({ theme, baseUrl }) => { if (location.origin === baseUrl) localStorage.setItem('theme', theme); }, { theme, baseUrl });
    c.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message)));
    return c;
  }
  const go = async (p, url) => { await p.goto(baseUrl + url); await p.locator('h1').waitFor(); };
  async function capture(p, name, primary) {
    if (primary) await expect(primary).toBeInViewport({ ratio: 1 });
    const m = await p.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll('button,a,summary,label:has(input[type="checkbox"])')].filter(e => e.getClientRects().length).map(e => ({ height: e.getBoundingClientRect().height, text: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 50) })) }));
    assert.ok(m.scrollWidth <= m.width + 1, name + ' overflow');
    assert.deepEqual(m.controls.filter(c => c.height < 43.5), [], name + ' short controls');
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
    report.cases.push({ name, ...m }); record();
  }
  async function login(p, user, pw = password, remember = false) {
    await go(p, '/login'); await p.getByLabel('E-mail', { exact: true }).fill(user.email);
    await p.getByLabel('Senha', { exact: true }).fill(pw);
    await p.getByLabel('Lembrar-me', { exact: true }).setChecked(remember);
    await p.getByRole('button', { name: 'Entrar no sistema' }).click(); await p.waitForURL(baseUrl + '/');
  }
  async function fillReset(p, value = nextPassword, confirm = value) {
    await p.getByLabel('Nova senha', { exact: true }).fill(value); await p.getByLabel('Confirmar nova senha', { exact: true }).fill(confirm);
  }
  try {
    // Real browser-generated video, only as local synthetic media; no remote download.
    const seedContext = await context(), seedPage = await seedContext.newPage(); await go(seedPage, '/login');
    const bytes = await seedPage.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const stream = canvas.captureStream(10), chunks = [], recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const done = new Promise(resolve => recorder.onstop = resolve); recorder.ondataavailable = e => chunks.push(e.data); recorder.start();
      for (let i = 0; i < 12; i++) { const g = canvas.getContext('2d'); g.fillStyle = i % 2 ? '#1d4ed8' : '#0f172a'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '18px sans-serif'; g.fillText('Vídeo de teste', 70, 90); await new Promise(r => setTimeout(r, 100)); }
      recorder.stop(); await done; stream.getTracks().forEach(t => t.stop()); return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
    });
    fs.writeFileSync(path.join(config.uploadDir, 'public-video.webm'), Buffer.from(bytes)); await seedContext.close();
    for (const [w, h] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['light', 'dark']) {
      const c = await context(w, h, theme), p = await c.newPage();
      await go(p, '/login'); await capture(p, `login-${w}-${theme}`, p.getByRole('button', { name: 'Entrar no sistema' }));
      await go(p, '/esqueci-senha'); await capture(p, `forgot-${w}-${theme}`, p.getByRole('button', { name: 'Enviar link de recuperação' }));
      await go(p, '/resetar-senha/' + validReset); await capture(p, `reset-${w}-${theme}`, p.getByRole('button', { name: 'Salvar nova senha' }));
      await go(p, '/compartilhado/' + share.token); await p.locator('canvas').waitFor(); await expect.poll(() => p.locator('canvas').evaluate(e => e.width)).toBeGreaterThan(0);
      await capture(p, `shared-pdf-${w}-${theme}`, p.getByRole('link', { name: 'Baixar material' }));
      for (const kind of ['image', 'document', 'external', 'missing', 'unsafe']) {
        await go(p, '/compartilhado/' + variants[kind].token); await expect(p.getByRole('heading', { level: 1 })).toHaveText(variants[kind].title);
        if (kind === 'image') await expect.poll(() => p.getByRole('img', { name: variants.image.title }).evaluate(e => e.naturalWidth)).toBeGreaterThan(0);
        await capture(p, `shared-${kind}-${w}-${theme}`);
      }
      await go(p, '/compartilhado/' + 'b'.repeat(64)); await expect(p.getByRole('heading', { name: 'Link indisponível' })).toBeVisible(); await capture(p, `shared-invalid-${w}-${theme}`);
      await c.close();
    }
    check('Login, recuperação, nova senha, PDF, imagem, documento, endereço externo, ausência e link inválido em três tamanhos e dois temas');
    const c = await context(), p = await c.newPage();
    await go(p, '/login'); await p.getByLabel('Senha', { exact: true }).fill('not-the-password'); await p.getByRole('button', { name: 'Mostrar senha', exact: true }).click(); await expect(p.getByLabel('Senha', { exact: true })).toHaveAttribute('type', 'text'); await p.getByRole('button', { name: 'Ocultar senha', exact: true }).click();
    await p.getByLabel('Lembrar-me', { exact: true }).check(); await expect(p.getByText(/Use apenas em dispositivo pessoal/)).toBeVisible(); await p.getByLabel('Lembrar-me', { exact: true }).uncheck();
    await p.getByLabel('E-mail', { exact: true }).fill(previewUser.email); await p.getByRole('button', { name: 'Entrar no sistema' }).click(); await expect(p.getByRole('alert')).toContainText('inválidos'); await p.getByLabel('Senha', { exact: true }).fill(''); await capture(p, 'login-error');
    await login(p, previewUser); assert.equal(await p.evaluate(() => JSON.parse(sessionStorage.getItem('labmathic_auth_session_v1')).user.id), previewUser.id); await c.close();
    const ac = await context(), ap = await ac.newPage(); await login(ap, admin, password, true); assert.equal(await ap.evaluate(() => !!localStorage.getItem('labmathic_auth_session_v1')), true); await ac.close();
    check('Login real docente/admin, seleção de duração, visibilidade e erro; sessão mantém armazenamento escolhido');
    const fc = await context(320, 600, 'dark'), fp = await fc.newPage();
    const countReset = () => db.prepare('SELECT COUNT(*) FROM password_reset_tokens WHERE user_id=?').pluck().get(previewUser.id);
    const beforeRequest = countReset();
    await go(fp, '/esqueci-senha'); await fp.getByLabel('E-mail cadastrado').fill(previewUser.email); await fp.getByRole('button', { name: 'Enviar link de recuperação' }).click(); await expect(fp.getByRole('status')).toContainText('Se esse e-mail estiver cadastrado'); assert.equal(countReset(), beforeRequest + 1); await capture(fp, 'forgot-success');
    await fp.getByRole('button', { name: 'Corrigir e-mail' }).click(); await fp.getByLabel('E-mail cadastrado').fill('nao-existe@audit.invalid'); await fp.getByRole('button', { name: 'Enviar link de recuperação' }).click(); await expect(fp.getByRole('status')).toContainText('Se esse e-mail estiver cadastrado'); assert.equal(countReset(), beforeRequest + 1);
    await fp.getByRole('button', { name: 'Corrigir e-mail' }).click(); await fp.getByLabel('E-mail cadastrado').fill(previewUser.email);
    await fp.route('**/api/auth/forgot-password', async r => { await r.fetch(); await r.fulfill({ status: 503, json: { error: 'Resposta perdida de teste' } }); });
    await fp.getByRole('button', { name: 'Enviar link de recuperação' }).click(); await expect(fp.getByRole('alert')).toContainText('Confira seu e-mail'); assert.equal(countReset(), beforeRequest + 2); await capture(fp, 'forgot-uncertain');
    await fp.unroute('**/api/auth/forgot-password'); await fp.getByRole('button', { name: 'Conferi meu e-mail; tentar novamente' }).click(); assert.equal(countReset(), beforeRequest + 2);
    await fp.route('**/api/auth/forgot-password', r => r.fulfill({ status: 429, json: { error: 'Aguarde antes de pedir outro link.' } })); await fp.getByRole('button', { name: 'Enviar link de recuperação' }).click(); await expect(fp.getByRole('alert')).toContainText('Aguarde'); await capture(fp, 'forgot-rate-limit'); await fc.close();
    check('Recuperação real sem SMTP, resposta genérica, correção de e-mail, limite e confirmação perdida sem reenvio');
    const rc = await context(390, 664), rp = await rc.newPage(); const reset = resetLink();
    await go(rp, '/resetar-senha/' + reset); await fillReset(rp, nextPassword, 'Different-password-1!'); await rp.getByRole('button', { name: 'Salvar nova senha' }).click(); await expect(rp.getByRole('alert')).toContainText('diferentes');
    await fillReset(rp); await rp.getByRole('button', { name: 'Mostrar nova senha', exact: true }).click(); await expect(rp.getByLabel('Confirmar nova senha', { exact: true })).toHaveAttribute('type', 'text'); await rp.getByRole('button', { name: 'Ocultar confirmar nova senha', exact: true }).click();
    await rp.getByRole('button', { name: 'Salvar nova senha' }).click(); await expect(rp.getByRole('status')).toContainText('nova senha foi salva'); assert.ok(await bcrypt.compare(nextPassword, db.prepare('SELECT password FROM users WHERE id=?').pluck().get(previewUser.id))); await capture(rp, 'reset-success');
    for (const [kind, token] of [['used', reset], ['expired', resetLink({ expired: true })], ['malformed', 'bad']]) {
      await go(rp, '/resetar-senha/' + token); if (kind !== 'malformed') { await fillReset(rp); await rp.getByRole('button', { name: 'Salvar nova senha' }).click(); }
      await expect(rp.getByRole('heading', { name: 'Link indisponível' })).toBeVisible(); await capture(rp, 'reset-' + kind);
    }
    const lostToken = resetLink(), auditBefore = db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='password_reset_completed'").pluck().get();
    await go(rp, '/resetar-senha/' + lostToken); await fillReset(rp, password);
    await rp.route('**/api/auth/reset-password', async r => { await r.fetch(); await r.fulfill({ status: 503, json: { error: 'Resposta perdida de teste' } }); });
    await rp.getByRole('button', { name: 'Salvar nova senha' }).click(); await expect(rp.getByRole('alert')).toContainText('pode ter sido alterada'); await expect(rp.locator('input')).toHaveCount(0); assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='password_reset_completed'").pluck().get(), auditBefore + 1); await capture(rp, 'reset-uncertain');
    await rp.unroute('**/api/auth/reset-password'); await login(rp, previewUser, password); await rc.close();
    check('Redefinição real, divergência, visibilidade, sucesso, link usado/expirado/malformado e resposta perdida com entrada pela nova senha');
    const sc = await context(), sp = await sc.newPage();
    await sp.route('**/api/share/*', r => r.fulfill({ status: 503, json: { error: 'Falha sintética' } })); await go(sp, '/compartilhado/' + share.token); await expect(sp.getByRole('heading', { name: 'Não foi possível carregar' })).toBeVisible(); await capture(sp, 'shared-network-error'); await sp.unroute('**/api/share/*'); await sp.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await sp.locator('canvas').waitFor();
    await sp.getByText('Sobre este material', { exact: true }).click(); await expect(sp.getByText('Material sintético para inspeção de interface.', { exact: true })).toBeVisible();
    const downloadPromise = sp.waitForEvent('download'); await sp.getByRole('link', { name: 'Baixar material' }).click(); assert.equal((await downloadPromise).suggestedFilename(), 'layout-fixture.pdf');
    await go(sp, '/compartilhado/' + variants.youtube.token); await expect(sp.locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abcdefghijk'); await capture(sp, 'shared-youtube');
    await go(sp, '/compartilhado/' + variants.video.token); await expect.poll(() => sp.locator('video').evaluate(e => e.readyState)).toBeGreaterThan(0); await sp.locator('video').click(); await capture(sp, 'shared-video');
    await go(sp, '/compartilhado/' + variants.external.token); await expect(sp.getByRole('link', { name: 'Abrir no site de origem' })).toHaveAttribute('rel', 'noopener noreferrer');
    await sp.route('**/uploads/public-image.png?*', r => r.fulfill({ status: 503, body: 'Image unavailable in test' }));
    await go(sp, '/compartilhado/' + variants.image.token); await expect(sp.getByRole('heading', { name: 'Não foi possível abrir a prévia' })).toBeVisible(); await capture(sp, 'shared-image-error');
    await sp.unroute('**/uploads/public-image.png?*'); await sp.getByRole('button', { name: 'Conferir link e tentar novamente' }).click(); await expect.poll(() => sp.getByRole('img', { name: variants.image.title }).evaluate(e => e.naturalWidth)).toBeGreaterThan(0);
    await sp.route('**/api/materials/*/public?*', r => r.fulfill({ status: 200, json: { id: materialId + 999, title: 'WRONG_MATERIAL_SECRET' } })); await go(sp, '/compartilhado/' + share.token); await expect(sp.getByRole('heading', { name: 'Não foi possível carregar' })).toBeVisible(); await expect(sp.getByText('WRONG_MATERIAL_SECRET')).toHaveCount(0); await sp.unroute('**/api/materials/*/public?*');
    db.prepare("UPDATE share_links SET expires_at='2000-01-01T00:00:00Z' WHERE token=?").run(variants.image.token); await go(sp, '/compartilhado/' + variants.image.token); await expect(sp.getByRole('heading', { name: 'Link indisponível' })).toBeVisible();
    db.prepare('DELETE FROM share_links WHERE token=?').run(variants.external.token); await go(sp, '/compartilhado/' + variants.external.token); await expect(sp.getByRole('heading', { name: 'Link indisponível' })).toBeVisible();
    await sc.close();
    check('Prévia e download autorizados, metadados, vídeo local, YouTube sem navegação externa, falha recuperável, identidade incorreta, expiração e revogação');
    const raceContext = await context(), race = await raceContext.newPage();
    // Leave login through an actual link while its response is held back.
    let releaseLogin, startLogin; const loginStarted = new Promise(r => { startLogin = r; }), loginGate = new Promise(r => { releaseLogin = r; }); let loginRequests = 0;
    await race.route('**/api/auth/login', async route => { loginRequests++; startLogin(); await loginGate; await route.continue().catch(() => {}); });
    await go(race, '/login'); await race.getByLabel('E-mail', { exact: true }).fill(previewUser.email); await race.getByLabel('Senha', { exact: true }).fill(password);
    await race.getByRole('button', { name: 'Entrar no sistema' }).dblclick(); await loginStarted; await expect(race.getByRole('button', { name: 'Entrando...' })).toBeDisabled();
    await race.getByRole('link', { name: 'Esqueceu a senha?' }).click(); releaseLogin(); await race.waitForLoadState('networkidle');
    assert.equal(loginRequests, 1); await expect(race.getByRole('heading', { name: 'Recuperar senha' })).toBeVisible();
    assert.equal(await race.evaluate(() => !!sessionStorage.getItem('labmathic_auth_session_v1') || !!localStorage.getItem('labmathic_auth_session_v1')), false);
    await race.unroute('**/api/auth/login');
    await race.getByLabel('E-mail cadastrado').fill(previewUser.email);
    await race.route('**/api/auth/forgot-password', r => r.fulfill({ status: 200, json: {} })); await race.getByRole('button', { name: 'Enviar link de recuperação' }).click(); await expect(race.getByRole('alert')).toContainText('Não recebemos a confirmação'); await race.unroute('**/api/auth/forgot-password');
    let releaseReset, startReset; const resetStarted = new Promise(r => { startReset = r; }), resetGate = new Promise(r => { releaseReset = r; });
    await race.route('**/api/auth/reset-password', async route => { startReset(); await resetGate; await route.fulfill({ status: 200, json: { message: 'Confirmação atrasada de teste' } }).catch(() => {}); });
    const oldReset = resetLink(), newReset = resetLink(); await go(race, '/resetar-senha/' + oldReset); await fillReset(race); await race.getByRole('button', { name: 'Salvar nova senha' }).click(); await resetStarted;
    // User navigates to another reset URL; the old form must be disposed.
    await go(race, '/resetar-senha/' + newReset); releaseReset(); await race.waitForLoadState('networkidle'); await expect(race.getByRole('heading', { name: 'Criar nova senha' })).toBeVisible(); await expect(race.getByLabel('Nova senha', { exact: true })).toHaveValue(''); await race.unroute('**/api/auth/reset-password');
    await fillReset(race); await race.route('**/api/auth/reset-password', r => r.fulfill({ status: 200, json: {} })); await race.getByRole('button', { name: 'Salvar nova senha' }).click(); await expect(race.getByRole('alert')).toContainText('pode ter sido alterada'); await race.unroute('**/api/auth/reset-password');
    await race.getByRole('link', { name: 'Pedir outro link' }).click(); await expect(race.getByRole('heading', { name: 'Recuperar senha' })).toBeVisible();
    await race.getByRole('link', { name: 'Voltar para entrar' }).click(); await expect(race.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeVisible();
    for (const [label, url] of [['Privacidade', '/privacidade'], ['Termos de uso', '/termos-de-uso']]) {
      await race.getByRole('link', { name: label, exact: true }).click(); await expect(race).toHaveURL(baseUrl + url); await race.goBack(); await expect(race.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeVisible();
    }
    await go(race, '/compartilhado/' + variants.missing.token); await race.getByRole('link', { name: 'Entrar', exact: true }).click(); await expect(race.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeVisible();
    await raceContext.close();
    check('Duplo clique e saída durante login, respostas malformadas e redefinição trocada não confirmam acesso ou senha por engano');
    const privateContext = await context(), privatePage = await privateContext.newPage(); await login(privatePage, admin);
    let sentProfessionalHeader = false;
    privatePage.on('request', r => { if (/\/api\/(share\/|materials\/\d+\/public)/.test(r.url()) && r.headers().authorization) sentProfessionalHeader = true; });
    await privatePage.route('**/api/share/*', r => r.fulfill({ status: 401, json: { error: 'Acesso público não confirmado' } }));
    await go(privatePage, '/compartilhado/' + share.token); await expect(privatePage.getByRole('heading', { name: 'Link indisponível' })).toBeVisible();
    assert.equal(sentProfessionalHeader, false); assert.ok(await privatePage.evaluate(() => sessionStorage.getItem('labmathic_auth_session_v1'))); await privatePage.unroute('**/api/share/*');
    await go(privatePage, '/'); await expect(privatePage).toHaveURL(baseUrl + '/');
    let releaseShare, startShare; const shareStarted = new Promise(r => { startShare = r; }), shareGate = new Promise(r => { releaseShare = r; });
    await privatePage.route('**/api/share/' + share.token, async r => { startShare(); await shareGate; await r.continue().catch(() => {}); });
    await go(privatePage, '/compartilhado/' + share.token); await shareStarted; await go(privatePage, '/compartilhado/' + variants.missing.token); releaseShare(); await privatePage.waitForLoadState('networkidle');
    await expect(privatePage.getByRole('heading', { level: 1 })).toHaveText(variants.missing.title); await expect(privatePage.locator('canvas')).toHaveCount(0);
    await privatePage.unroute('**/api/share/' + share.token); await privateContext.close();
    check('Consulta pública não envia token profissional nem encerra a sessão; troca de link descarta a leitura anterior');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.message.replace(/[a-f0-9]{64}/g, '[link de teste]'); record(); throw error; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runPublicAccessBrowser };
