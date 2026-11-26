const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runAuxiliaryBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, materialId, db, output }) {
  assert.equal(process.env.AUXILIARY_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/); assert.equal(output, path.join(root, 'tmp/auxiliary-qa'));
  const report = { status: 'running', syntheticDataOnly: true, cases: [], inventory: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, process.env.AUXILIARY_FUNCTIONAL_ONLY === '1' ? 'report-functional.json' : 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Auxiliares:', description); };
  const api = async (url, body, user = teacher) => { const r = await fetch(baseUrl + '/api' + url, { method: 'POST', headers: { Authorization: 'Bearer ' + tokenFor(user), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok, url); return r.json(); };
  const entry = await api(`/classes/${classPublicId}/codes`, { maxUses: 100, validDays: 1 });
  const otherEntry = await api(`/classes/${classPublicId}/codes`, { maxUses: 100, validDays: 1 });
  const teacherName = 'Professora Maria da Conceição de Albuquerque dos Santos';
  db.prepare('UPDATE users SET name=? WHERE id=?').run(teacherName, teacher.id); teacher = { ...teacher, name: teacherName };
  function notify(title, type = 'new_material', data = { material_id: materialId }) {
    return Number(db.prepare('INSERT INTO notifications(user_id,type,title,message,data) VALUES (?,?,?,?,?)').run(teacher.id, type, title, 'Confira os recursos para as próximas aulas e acompanhe o trabalho da turma. '.repeat(2), JSON.stringify(data)).lastInsertRowid);
  }
  const firstId = notify('Material novo para planejar a aula com a turma'); notify('Aviso sem destino automático', 'system');
  if (process.env.AUXILIARY_INTERACTIVE === '1') {
    const file = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(file, JSON.stringify({ baseUrl, user: teacher, token: tokenFor(teacher), entryCode: entry.code })); console.log('AUXILIARY_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => { const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250); const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive expired')); }, 480000); }); }
    finally { if (fs.existsSync(file)) fs.unlinkSync(file); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  async function context(w = 1024, h = 600, theme = 'light', user = null, announcements = false) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, ...(w < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c); c.setDefaultTimeout(7000);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort());
    if (!announcements) await c.route('**/api/announcements/current?*', r => r.fulfill({ json: { announcement: null } }));
    await c.addInitScript(({ baseUrl, theme, user, token }) => { if (location.origin !== baseUrl) return; localStorage.setItem('theme', theme); if (user) sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); }, { baseUrl, theme, user, token: user ? tokenFor(user) : null });
    c.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message)));
    return c;
  }
  async function go(p, url) { await p.goto(baseUrl + url); await p.waitForLoadState('networkidle'); }
  async function capture(p, name, scope = 'body', primary) {
    // Inspect settled geometry; dropdowns enter with a scale animation.
    await p.waitForTimeout(350);
    if (primary) await expect(primary).toBeInViewport({ ratio: 1 });
    const m = await p.locator(scope).evaluate(e => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      controls: [...e.querySelectorAll('a,button,input,summary')].filter(n => n.getClientRects().length && !['checkbox', 'hidden'].includes(n.type)).map(n => ({ text: (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 45), height: n.getBoundingClientRect().height })),
      floating: [...document.querySelectorAll('.header-floating,[data-product-announcement]')].filter(n => n.getClientRects().length).map(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vh: innerHeight }; }) }));
    assert.ok(m.scrollWidth <= m.width + 1, name + ' overflow'); assert.deepEqual(m.controls.filter(c => c.height < 43.5), [], name + ' short controls');
    for (const r of m.floating) assert.ok(r.left >= 0 && r.right <= m.width + 1 && r.top >= 0 && r.bottom <= r.vh + 1, name + ' popup clipped');
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' }); report.cases.push({ name, ...m }); record();
  }
  try {
    if (process.env.AUXILIARY_FUNCTIONAL_ONLY !== '1') for (const [w, h] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['light', 'dark']) {
      const c = await context(w, h, theme), p = await c.newPage();
      await go(p, '/entrar-na-turma?codigo=' + entry.code); await capture(p, `join-${w}-${theme}`, '[data-join-class]', p.getByRole('button', { name: 'Confirmar entrada' }));
      for (const [name, url, count] of [['privacy', '/privacidade', 12], ['terms', '/termos-de-uso', 11]]) {
        await go(p, url); await capture(p, `${name}-${w}-${theme}`, '.legal-document');
        await p.getByText('Ir para um assunto', { exact: true }).click(); await expect(p.getByRole('navigation', { name: 'Assuntos deste documento' }).getByRole('link')).toHaveCount(count);
        await p.getByRole('navigation', { name: 'Assuntos deste documento' }).getByRole('link').nth(count - 1).click(); await expect(p.locator('#secao-' + count)).toBeInViewport(); await capture(p, `${name}-last-${w}-${theme}`, '.legal-document');
        await p.getByRole('link', { name: 'Voltar ao início do documento' }).click(); await expect(p.locator('#documento-inicio')).toBeInViewport(); await p.getByText('Ir para um assunto', { exact: true }).click();
      }
      await go(p, '/pagina-nao-existente'); await capture(p, `404-public-${w}-${theme}`, '[data-not-found]', p.getByRole('link', { name: 'Entrar na plataforma' })); await p.getByRole('link', { name: 'Entrar na plataforma' }).click(); await expect(p).toHaveURL(baseUrl + '/login'); await c.close();
      for (const user of [teacher, admin]) {
        const ac = await context(w, h, theme, user), ap = await ac.newPage(); await go(ap, '/perfil');
        await ap.getByRole('button', { name: 'Abrir menu', exact: true }).click(); await capture(ap, `menu-${user.role}-${w}-${theme}`, '[data-main-header]');
        await ap.keyboard.press('Escape'); await expect(ap.getByRole('button', { name: 'Abrir menu', exact: true })).toBeFocused();
        await ap.getByRole('button', { name: 'Menu do usuário' }).click(); await capture(ap, `account-${user.role}-${w}-${theme}`, '[data-main-header]');
        await ap.getByRole('button', { name: 'Notificações', exact: true }).click(); await expect(ap.locator('[data-account-menu]')).toHaveCount(0); await ap.getByRole('heading', { name: 'Notificações', exact: true }).waitFor(); await expect(ap.getByText('Atualizando avisos…')).toHaveCount(0); await capture(ap, `notifications-${user.role}-${w}-${theme}`, '[data-main-header]');
        await ap.keyboard.press('Escape'); await expect(ap.getByRole('button', { name: 'Notificações', exact: true })).toBeFocused(); await ac.close();
      }
    }
    if (process.env.AUXILIARY_FUNCTIONAL_ONLY !== '1') check('Entrada, documentos/índices, 404, menu compacto, conta e notificações de professor/admin em três resoluções e dois temas');
    const jc = await context(320, 600, 'dark'), jp = await jc.newPage();
    await go(jp, '/entrar-na-turma'); await jp.getByLabel('Código da turma').fill('ABCD'); await jp.getByLabel('Seu nome na escola').fill('José QA31'); await jp.getByRole('button', { name: 'Confirmar entrada' }).click(); await expect(jp.getByRole('alert')).toContainText('16'); await capture(jp, 'join-validation', '[data-join-class]');
    await jp.getByLabel('Código da turma').fill(entry.code); let writes = [];
    await jp.route('**/api/classes/join', async r => { writes.push(r.request().postDataJSON()); await r.fetch(); await r.fulfill({ status: 503, json: { error: 'Resposta perdida de teste' } }); });
    const before = db.prepare('SELECT COUNT(*) FROM students WHERE owner_teacher_id=?').pluck().get(teacher.id);
    await jp.getByRole('button', { name: 'Confirmar entrada' }).dblclick(); await expect(jp.getByRole('alert')).toContainText('Não conseguimos confirmar'); await expect(jp.getByLabel('Seu nome na escola')).toBeDisabled(); await capture(jp, 'join-uncertain', '[data-join-class]', jp.getByRole('button', { name: 'Conferir ou concluir esta entrada' }));
    assert.equal(db.prepare('SELECT COUNT(*) FROM students WHERE owner_teacher_id=?').pluck().get(teacher.id), before + 1);
    await jp.unroute('**/api/classes/join'); await jp.route('**/api/classes/join', r => { writes.push(r.request().postDataJSON()); return r.continue(); });
    await jp.getByRole('button', { name: 'Conferir ou concluir esta entrada' }).click(); await expect(jp.getByRole('heading', { name: 'Entrada confirmada' })).toBeVisible(); assert.deepEqual(writes[0], writes[1]); assert.equal(writes.length, 2); assert.equal(db.prepare('SELECT COUNT(*) FROM students WHERE owner_teacher_id=?').pluck().get(teacher.id), before + 1); await capture(jp, 'join-confirmed', '[data-join-class]');
    await go(jp, '/entrar-na-turma?codigo=' + otherEntry.code); await expect(jp.getByLabel('Código da turma')).toHaveValue(otherEntry.code); await expect(jp.getByLabel('Seu nome na escola')).toHaveValue('');
    db.prepare("UPDATE school_class_entry_codes SET created_at='1999-12-31T00:00:00Z', expires_at='2000-01-01T00:00:00Z' WHERE public_id=?").run(otherEntry.id);
    await jp.getByLabel('Seu nome na escola').fill('Outro estudante QA31'); await jp.getByRole('button', { name: 'Confirmar entrada' }).click(); await expect(jp.getByRole('alert')).toContainText('Não foi possível'); await expect(jp.getByLabel('Código da turma')).toBeEnabled();
    db.prepare('UPDATE school_class_entry_codes SET use_count=max_uses WHERE public_id=?').run(entry.id);
    await go(jp, '/entrar-na-turma?codigo=' + entry.code); await jp.getByLabel('Seu nome na escola').fill('Limite QA31'); await jp.getByRole('button', { name: 'Confirmar entrada' }).click(); await expect(jp.getByRole('alert')).toBeVisible();
    db.prepare('UPDATE school_class_entry_codes SET use_count=1 WHERE public_id=?').run(entry.id);
    // Homologation deliberately opens pilot flags; its emergency stop still applies.
    db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='QA31 isolado',kill_switch_activated_by=?,kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='classes.entry_codes'").run(admin.id);
    try { await jp.getByRole('button', { name: 'Confirmar entrada' }).click(); await expect(jp.getByRole('alert')).toBeVisible(); await expect(jp.getByLabel('Seu nome na escola')).toBeEnabled(); }
    finally { db.prepare("UPDATE feature_flags SET kill_switch_active=0,kill_switch_reason=NULL,kill_switch_activated_by=NULL,kill_switch_activated_at=NULL WHERE flag_key='classes.entry_codes'").run(); }
    await jp.getByRole('link', { name: 'Ir para a avaliação' }).click(); await expect(jp).toHaveURL(baseUrl + '/responder'); await jc.close();
    check('Entrada real, validação, confirmação perdida e replay idempotente, troca de link, expiração, limite de uso e flag desligada');
    const lc = await context(), lp = await lc.newPage();
    for (const [url, count] of [['/privacidade', 12], ['/termos-de-uso', 11]]) {
      await go(lp, url + '#secao-7'); await expect(lp.locator('#secao-7')).toBeInViewport(); await expect(lp.locator('#secao-7')).toBeFocused();
      await lp.getByText('Ir para um assunto', { exact: true }).click();
      for (let i = 0; i < count; i++) { await lp.getByRole('navigation', { name: 'Assuntos deste documento' }).getByRole('link').nth(i).click(); await expect(lp.locator('#secao-' + (i + 1))).toBeInViewport(); }
      await lp.getByRole('link', { name: 'Voltar para o login' }).click(); await expect(lp).toHaveURL(baseUrl + '/login');
    }
    await lc.close(); check('Todas as âncoras dos documentos, acesso direto, foco e retorno exercitados sem alterar texto jurídico');
    for (const user of [teacher, admin, previewUser]) {
      const dc = await context(1440, 800, 'dark', user), dp = await dc.newPage(); await go(dp, '/perfil');
      for (const group of ['Avaliações', 'Recursos']) { await dp.getByRole('button', { name: group, exact: true }).click(); await capture(dp, `desktop-${group === 'Avaliações' ? 'assessments' : 'resources'}-${user.id}`, '[data-main-header]'); await dp.keyboard.press('Escape'); await expect(dp.getByRole('button', { name: group, exact: true })).toBeFocused(); }
      await dp.getByRole('button', { name: 'Alternar tema' }).click(); await expect(dp.locator('html')).not.toHaveClass(/dark/); await dp.getByRole('button', { name: 'Alternar tema' }).click();
      await dp.setViewportSize({ width: 1280, height: 600 }); await dp.getByRole('button', { name: 'Recursos', exact: true }).click(); await capture(dp, `desktop-1280-${user.id}`, '[data-main-header]');
      await dp.keyboard.press('Tab'); await dp.keyboard.press('Tab'); await dp.keyboard.press('Tab'); await expect(dp.locator('#desktop-resources-menu')).toHaveCount(0);
      await dp.getByRole('button', { name: 'Avaliações', exact: true }).click(); await dp.setViewportSize({ width: 1024, height: 600 }); await expect(dp.locator('#desktop-assessments-menu')).toHaveCount(0); await dp.setViewportSize({ width: 1440, height: 800 });
      await dp.getByRole('button', { name: 'Recursos', exact: true }).click(); await dp.locator('#desktop-resources-menu').getByRole('link', { name: /Biblioteca/ }).click(); await expect(dp).toHaveURL(baseUrl + '/biblioteca'); await expect(dp.locator('#desktop-resources-menu')).toHaveCount(0);
      await go(dp, '/nao-existe'); await expect(dp.getByRole('link', { name: 'Abrir Biblioteca' })).toBeVisible(); await dp.getByRole('link', { name: 'Ir para Início' }).click(); await expect(dp).toHaveURL(baseUrl + '/'); await dc.close();
    }
    check('Grupos desktop, destinos por perfil, alternância de tema, fechamento na navegação e 404 profissional');
    const kc = await context(320, 600, 'dark', teacher), kp = await kc.newPage(); await go(kp, '/perfil');
    for (let i = 0; i < 4; i++) { await kp.getByRole('button', { name: 'Menu do usuário' }).click(); await kp.keyboard.press('Tab'); await expect(kp.getByRole('button', { name: 'Sair da conta' })).toBeFocused(); await kp.keyboard.press('Tab'); await expect(kp.locator('[data-account-menu]')).toHaveCount(0); }
    await kc.close();
    const nc = await context(390, 664, 'light', teacher), np = await nc.newPage();
    await np.route('**/api/notifications?*', r => r.fulfill({ status: 503, json: { error: 'Falha de teste' } })); await go(np, '/perfil'); await np.getByRole('button', { name: 'Notificações', exact: true }).click(); await expect(np.locator('[data-notification-panel]').getByRole('alert')).toBeVisible(); await expect(np.getByText('Nenhuma notificação registrada.')).toHaveCount(0); await capture(np, 'notifications-error', '[data-main-header]');
    await np.unroute('**/api/notifications?*'); await np.getByRole('button', { name: 'Atualizar avisos' }).click(); await expect(np.getByRole('button', { name: /Material novo para planejar/ })).toBeVisible();
    await np.getByRole('button', { name: /Material novo para planejar/ }).click(); await expect(np).toHaveURL(baseUrl + '/material/' + materialId); await expect.poll(() => db.prepare('SELECT read FROM notifications WHERE id=?').pluck().get(firstId)).toBe(1);
    await np.getByRole('button', { name: 'Notificações', exact: true }).click(); await expect(np.getByText('Atualizando avisos…')).toHaveCount(0);
    await np.route('**/api/notifications/read-all', async r => { await r.fetch(); await r.fulfill({ status: 503, json: { error: 'Resposta perdida' } }); });
    await np.getByRole('button', { name: 'Marcar todas como lidas' }).click(); await expect(np.locator('[data-notification-panel]').getByRole('alert')).toContainText('Não confirmamos'); await capture(np, 'notifications-write-error', '[data-main-header]'); await np.unroute('**/api/notifications/read-all');
    await np.getByRole('button', { name: 'Atualizar avisos' }).click(); await expect(np.getByRole('button', { name: 'Marcar todas como lidas' })).toHaveCount(0);
    await np.keyboard.press('Escape'); await np.getByRole('button', { name: 'Menu do usuário' }).click(); await np.locator('[data-main-header]').click({ position: { x: 1, y: 1 } }); await expect(np.locator('[data-account-menu]')).toHaveCount(0); await nc.close();
    check('Notificações distinguem falha de vazio, recuperam consulta e marcação perdida, abrem material real e não inventam contagens');
    const fc = await context(320, 600, 'dark', teacher), fp = await fc.newPage(); let reads = 0;
    await fp.route('**/api/notifications?*', r => { reads++; return r.fulfill({ status: 429, headers: { 'Retry-After': '60' }, json: { error: 'Aguarde' } }); });
    await go(fp, '/perfil'); await fp.getByRole('button', { name: 'Notificações', exact: true }).click(); await expect(fp.getByRole('button', { name: 'Atualizar avisos' })).toBeEnabled(); const readCount = reads;
    await fp.getByRole('button', { name: 'Atualizar avisos' }).click(); assert.equal(reads, readCount); await expect(fp.locator('[data-notification-panel]').getByRole('alert')).toContainText('Aguarde');
    await fp.unroute('**/api/notifications?*'); await fp.route('**/api/notifications?*', r => r.fulfill({ json: { notifications: [{ id: 9, user_id: admin.id, title: 'AVISO DE OUTRA CONTA', type: 'system', created_at: '2026-09-01', read: 0 }], unreadCount: 1, supportUnreadCount: 0 } }));
    await fp.reload(); await fp.waitForLoadState('networkidle'); await fp.getByRole('button', { name: 'Notificações', exact: true }).click(); await expect(fp.locator('[data-notification-panel]').getByRole('alert')).toBeVisible(); await expect(fp.getByText('AVISO DE OUTRA CONTA')).toHaveCount(0);
    await fp.unroute('**/api/notifications?*'); let releaseRead, readStarted; const heldRead = new Promise(r => releaseRead = r), startedRead = new Promise(r => readStarted = r);
    await fp.route('**/api/notifications?*', async r => { readStarted(); await heldRead; await r.fulfill({ json: { notifications: [], unreadCount: 0, supportUnreadCount: 0 } }).catch(() => {}); });
    await fp.getByRole('button', { name: 'Atualizar avisos' }).click(); await startedRead; await fp.keyboard.press('Escape'); await fp.getByRole('button', { name: 'Menu do usuário' }).click(); await fp.getByRole('button', { name: 'Sair da conta' }).click(); await expect(fp).toHaveURL(baseUrl + '/login'); releaseRead(); await fp.waitForTimeout(150); await expect(fp.locator('[data-notification-panel]')).toHaveCount(0); await fc.close();
    check('Notificações respeitam Retry-After, recusam dados de outra conta e descartam retorno atrasado após sair');
    const noticeId = db.prepare('SELECT id FROM announcements WHERE active=1 ORDER BY created_at DESC,id DESC LIMIT 1').pluck().get(); assert.ok(noticeId);
    for (const [w, h, theme] of [[1024, 600, 'light'], [390, 664, 'dark'], [320, 600, 'light'], [320, 600, 'dark']]) {
      db.prepare('DELETE FROM announcement_impressions WHERE user_id=?').run(teacher.id);
      const mc = await context(w, h, theme, teacher, true), mp = await mc.newPage(); await go(mp, '/perfil'); await mp.getByRole('dialog').waitFor(); await capture(mp, `announcement-${w}-${theme}`, '[data-product-announcement]', mp.getByRole('button', { name: 'Entendi, continuar' }));
      if (w === 320) { await mp.getByRole('button', { name: 'Fechar novidades' }).scrollIntoViewIfNeeded(); await capture(mp, `announcement-footer-${theme}`, '[data-product-announcement]', mp.getByRole('button', { name: 'Fechar novidades' })); await mp.getByRole('button', { name: 'Fechar novidades' }).click(); }
      else await mp.getByRole('button', { name: 'Entendi, continuar' }).click();
      await expect(mp.getByRole('dialog')).toHaveCount(0); await mp.reload(); await mp.waitForLoadState('networkidle'); await expect(mp.getByRole('dialog')).toHaveCount(0); await mc.close();
    }
    db.prepare('DELETE FROM announcement_impressions WHERE user_id=?').run(teacher.id);
    const ec = await context(320, 600, 'dark', teacher, true), ep = await ec.newPage(); await go(ep, '/perfil'); await ep.getByRole('dialog').waitFor(); await ep.keyboard.press('Escape'); await expect(ep.getByRole('dialog')).toHaveCount(0); await ec.close();
    check('Novidades compactas, conteúdo real, continuar/Escape e limite por acesso, sem bloquear a conta administrativa');
    const realNotice = JSON.parse(db.prepare('SELECT payload_json FROM announcements WHERE id=?').pluck().get(noticeId));
    for (const feature of realNotice.features) {
      db.prepare('DELETE FROM announcement_impressions WHERE user_id=?').run(teacher.id);
      const ac = await context(390, 664, 'light', teacher, true), ap = await ac.newPage(); await go(ap, '/perfil'); await ap.getByRole('dialog').getByRole('button', { name: feature.actionLabel }).click(); await expect(ap).toHaveURL(baseUrl + feature.actionPath); await expect(ap.locator('[data-product-announcement]')).toHaveCount(0); await ac.close();
    }
    db.prepare('DELETE FROM announcement_impressions WHERE user_id=?').run(teacher.id);
    for (const close of ['button', 'backdrop', 'limit']) {
      const ac = await context(1024, 600, 'dark', teacher, true), ap = await ac.newPage(); await go(ap, '/perfil');
      if (close === 'limit') await expect(ap.locator('[data-product-announcement]')).toHaveCount(0);
      else { await ap.locator('[data-product-announcement]').waitFor(); if (close === 'button') await ap.getByRole('button', { name: 'Fechar aviso' }).click(); else await ap.mouse.click(2, 2); await expect(ap.locator('[data-product-announcement]')).toHaveCount(0); }
      await ac.close();
    }
    for (const fault of ['malformed', 'error', 'late']) {
      const ac = await context(390, 664, 'dark', teacher, true), ap = await ac.newPage(); let impressions = 0, releaseNotice; const held = new Promise(r => releaseNotice = r);
      await ap.route('**/api/announcements/*/impressions', r => { impressions++; return r.continue(); });
      await ap.route('**/api/announcements/current?*', async r => { if (fault === 'late') await held; await r.fulfill({ status: fault === 'error' ? 503 : 200, json: { announcement: { id: noticeId, title: 'Aviso inválido' } } }).catch(() => {}); });
      await ap.goto(baseUrl + '/perfil'); await ap.getByRole('button', { name: 'Menu do usuário' }).click();
      if (fault === 'late') { await ap.getByRole('button', { name: 'Sair da conta' }).click(); await expect(ap).toHaveURL(baseUrl + '/login'); releaseNotice(); }
      await ap.waitForTimeout(200); assert.equal(impressions, 0); await expect(ap.locator('[data-product-announcement]')).toHaveCount(0); await ac.close();
    }
    check('Ações de novidades mantidas, fechar/backdrop e limite de dois acessos reais; erro, conteúdo inválido e resposta tardia não abrem aviso');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.message; record(); throw error; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runAuxiliaryBrowser };
