module.exports = {
  version: 30,
  name: 'assessment_exemptions',
  description: 'Liberação gradual da dispensa antes da abertura, preservando participantes e acessos anteriores.',
  up(db) {
    db.exec(`INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
      VALUES ('classes.assessment_exemptions','Dispensa antes da avaliação',
        'Dispensa explícita em rascunhos sem tentativa de resposta, com revogação de acessos e auditoria.',0,0,0)`);
  },
};
