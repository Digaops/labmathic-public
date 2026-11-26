const { createHmac } = require('node:crypto');

function protectProfessionalFingerprint(fingerprint, secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('Segredo ausente para proteger recibos institucionais.');
  return createHmac('sha256', secret)
    .update('labmathic:institutional-professional-receipt:v1:')
    .update(fingerprint)
    .digest('hex');
}

module.exports = { protectProfessionalFingerprint };
