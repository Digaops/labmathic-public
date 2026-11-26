const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const source = import('../../client/src/services/auxiliaryView.mjs');
function legalContent(source) {
 const article = /<article\b[^>]*>([\s\S]*?)<\/article>/.exec(source)[1];
 return JSON.stringify({
   text: article.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
   titles: [...article.matchAll(/<Section title="([^"]+)"/g)].map(m => m[1]),
   lists: [...source.matchAll(/const (\w+) = (\[[\s\S]*?\]);/g)].map(m => [m[1], m[2].replace(/\s+/g,' ')])
 });
}
test('privacidade e termos mantêm integralmente os textos, títulos e listas originais', () => {
 const originals = {"PrivacyPolicy":"cb103f1baae8e05a7ee0d5e5c73d193996d48c9834f751e0667bd670136e3bce","TermsOfUse":"4b1cf5428a4494f832796e3d8d725a609143ebab71a10736cede3efaeb7b8735"};
 for (const [name, digest] of Object.entries(originals)) {
  const current = fs.readFileSync(path.join(__dirname, '../../client/src/pages/' + name + '.jsx'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(legalContent(current)).digest('hex'), digest, name);
 }
});
test('código de turma não trunca um prefixo válido nem aceita mais de 16 posições', async () => {
 const { formatClassCode, joinProblem } = await source;
 assert.equal(formatClassCode('abcd efgh ijkl mnop'), 'ABCD-EFGH-IJKL-MNOP');
 assert.equal(joinProblem({ code: 'ABCD-EFGH-IJKL-MNOP', displayName: 'José Silva' }), '');
 assert.ok(joinProblem({ code: 'ABCDEFGHIJKLMNOPQ', displayName: 'José' }));
 assert.ok(joinProblem({ code: 'ABCDEFGHIJKLMNOP', displayName: ' ' }));
});
test('entrada só confirma com turma, professor e resultado completos', async () => {
 const { parseClassJoin } = await source;
 const valid = { joined: true, alreadyJoined: false, className: '7º A', teacherName: 'Docente', message: 'Entrada confirmada.' };
 assert.equal(parseClassJoin(valid), valid);
 for (const bad of [{}, { ...valid, joined: false }, { ...valid, teacherName: null }, { ...valid, alreadyJoined: undefined }]) assert.throws(() => parseClassJoin(bad));
});
test('avisos não aceitam conta trocada, duplicados ou contagens inválidas', async () => {
 const { parseNotifications } = await source;
 const n = { id: 1, user_id: 2, read: 0, title: 'Aviso', type: 'new_material', created_at: '2026-09-10' };
 assert.equal(parseNotifications({ notifications: [n], unreadCount: 1, supportUnreadCount: 0 }, 2).notifications.length, 1);
 for (const bad of [{}, { notifications: [n], unreadCount: -1, supportUnreadCount: 0 }, { notifications: [n, n], unreadCount: 2, supportUnreadCount: 0 }, { notifications: [{ ...n, user_id: 9 }], unreadCount: 1, supportUnreadCount: 0 }]) assert.throws(() => parseNotifications(bad, 2));
});
test('destinos de notificações só usam IDs e rotas internas conhecidas', async () => {
 const { notificationPath } = await source;
 assert.equal(notificationPath({ type: 'new_material', data: '{"material_id":3}' }), '/material/3');
 assert.equal(notificationPath({ type: 'new_material', data: { material_id: '1/../admin' } }), null);
 assert.equal(notificationPath({ type: 'support_reply', data: '{bad' }), '/fale-conosco');
 assert.equal(notificationPath({ type: 'teacher_question_created' }), '/banco-questoes?tab=author');
});
test('novidades preservam o destino real de autoria e rejeitam ações externas', async () => {
 const { announcementPath, parseAnnouncement, parseImpression } = await source;
 const valid = { id: 2, title: 'Novidades', maxImpressions: 2, payload: { intro: 'Conheça', features: [{ key: 'author_questions', title: 'Criar questão', description: 'Sua questão', actionLabel: 'Criar', actionPath: '/banco-questoes?tab=author&create=1' }] } };
 assert.equal(parseAnnouncement(valid), valid);
 assert.equal(announcementPath('//example.org'), null);
 assert.equal(announcementPath('/admin'), null);
 assert.throws(() => parseAnnouncement({ ...valid, payload: { ...valid.payload, features: [{ ...valid.payload.features[0], actionPath: 'javascript:alert(1)' }] } }));
 assert.equal(parseImpression({ announcement: valid, impressions: 1, remaining: 1 }, 2), valid);
 assert.throws(() => parseImpression({ announcement: valid, impressions: 1, remaining: 1 }, 3));
});
