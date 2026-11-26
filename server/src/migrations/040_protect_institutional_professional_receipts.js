const { protectProfessionalFingerprint } = require('../services/institutionalReceiptFingerprint');

module.exports = {
  version: 40,
  name: 'protect_institutional_professional_receipts',
  description: 'Protege impressões digitais de cadastros profissionais preservando recibos e auditoria.',
  up(db, { institutionalFingerprintSecret } = {}) {
    const receipts = db.prepare(`SELECT id, request_fingerprint FROM institutional_write_operations
      WHERE operation_type = 'create_professional'`).all();
    if (!receipts.length) return;

    // The migration runner wraps the trigger suspension, conversion and ledger write in one transaction.
    db.exec('DROP TRIGGER institutional_write_operations_prevent_update');
    const protect = db.prepare('UPDATE institutional_write_operations SET request_fingerprint = ? WHERE id = ?');
    for (const receipt of receipts) {
      protect.run(protectProfessionalFingerprint(receipt.request_fingerprint, institutionalFingerprintSecret), receipt.id);
    }
    db.exec(`CREATE TRIGGER institutional_write_operations_prevent_update
      BEFORE UPDATE ON institutional_write_operations
      BEGIN
        SELECT RAISE(ABORT, 'institutional_write_operation_is_immutable');
      END;`);
  },
};
