const nodemailer = require('nodemailer');

function normalizeText(value, maxLength = 240) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function readAlertConfig(env = process.env) {
  const rawPort = String(env.SMTP_PORT || '587');
  const config = {
    host: normalizeText(env.SMTP_HOST, 200),
    port: /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN,
    user: normalizeText(env.SMTP_USER, 320),
    pass: String(env.SMTP_PASS || ''),
    from: normalizeText(env.BACKUP_ALERT_FROM || env.SMTP_FROM, 320),
    to: normalizeText(env.BACKUP_ALERT_EMAIL, 320),
  };

  if (!config.host || !config.user || !config.pass || !config.from || !config.to) {
    throw new Error('SMTP e BACKUP_ALERT_EMAIL devem estar completos antes de agendar backups.');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('SMTP_PORT invalido para os alertas de backup.');
  }
  if (!config.from.includes('@') || !config.to.includes('@')) {
    throw new Error('E-mail de origem ou destino invalido para os alertas de backup.');
  }

  return config;
}

async function sendBackupAlert({
  status,
  runId,
  backupName,
  environment = 'production',
  error,
  env = process.env,
  createTransport = nodemailer.createTransport,
}) {
  const config = readAlertConfig(env);
  const succeeded = status === 'success';
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  const lines = [
    `Status: ${succeeded ? 'SUCESSO' : 'FALHA'}`,
    `Ambiente: ${normalizeText(environment, 40)}`,
    `Execucao: ${normalizeText(runId, 80)}`,
    `Horario UTC: ${new Date().toISOString()}`,
  ];

  if (backupName) lines.push(`Snapshot local: ${normalizeText(backupName, 100)}`);
  if (error) lines.push(`Motivo seguro: ${normalizeText(error.message || error)}`);

  lines.push('', 'Nenhuma credencial, dado pessoal ou caminho do servidor foi incluido neste alerta.');

  await transporter.sendMail({
    from: config.from,
    to: config.to,
    subject: `[LabMathic] ${succeeded ? 'Backup concluido' : 'FALHA no backup'}`,
    text: `${lines.join('\n')}\n`,
  });
}

module.exports = { normalizeText, readAlertConfig, sendBackupAlert };
