module.exports = {
  version: 35,
  name: 'school_coordination',
  description: 'Liberação independente da consulta pedagógica escolar, sem alterar turmas ou resultados.',
  up(db) {
    db.exec(`INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
      VALUES ('institutions.school_coordination','Acompanhamento da escola',
        'Consulta restrita às escolas autorizadas, com turmas confirmadas e proteção de grupos pequenos.',0,0,0)`);
  },
};
