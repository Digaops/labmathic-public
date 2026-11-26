const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');

test('CommonJS e createTransport preservam envelope e mensagem de recuperação sem enviar e-mail', async () => {
  assert.equal(typeof nodemailer.createTransport, 'function');
  const transport = nodemailer.createTransport({ jsonTransport: true, disableFileAccess: true, disableUrlAccess: true });
  const resetUrl = 'https://example.invalid/resetar-senha/token-sintetico';
  const subject = 'Redefinição de Senha - Biblioteca Digital';
  const text = `Olá, professora. Redefina sua senha: ${resetUrl}. Este link expira em 1 hora.`;
  const html = `<h2>Redefinição de Senha</h2><p><a href="${resetUrl}">Redefinir Senha</a></p><p>Este link expira em 1 hora.</p>`;
  try {
    const response = await transport.sendMail({ from: 'LabMathic <noreply@example.invalid>',
      to: 'Professora João <professora@example.invalid>', subject, text, html });
    assert.deepEqual(response.envelope, { from: 'noreply@example.invalid', to: ['professora@example.invalid'] });
    const message = JSON.parse(response.message);
    assert.equal(message.subject, subject);
    assert.equal(message.text, text);
    assert.equal(message.html, html);
  } finally { transport.close(); }
});

test('transporte atualizado respeita bloqueio de leitura de arquivo local', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true,
    disableFileAccess: true, disableUrlAccess: true });
  try {
    await assert.rejects(transport.sendMail({ from: 'a@example.invalid', to: 'b@example.invalid',
      subject: 'Teste sintético', attachments: [{ filename: 'teste.js', path: __filename }] }), /file access rejected/i);
  } finally { transport.close(); }
});

test('política do transporte impede acesso a URL mesmo se a mensagem tentar liberá-lo', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true,
    disableFileAccess: true, disableUrlAccess: true });
  try {
    await assert.rejects(transport.sendMail({ from: 'a@example.invalid', to: 'b@example.invalid',
      subject: 'Teste sintético', disableUrlAccess: false,
      attachments: [{ filename: 'remoto.txt', href: 'https://example.invalid/nao-consultar.txt' }] }), /url access rejected/i);
  } finally { transport.close(); }
});
