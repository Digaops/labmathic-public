const { installQuestionEditorialPilot } = require('../services/installQuestionEditorialPilot');

module.exports = {
  version: 42,
  name: 'question_editorial_curation',
  description: 'Retira questões divergentes de novos usos e prepara itens inéditos para revisão pedagógica.',
  up(db) {
    db.exec(`
      CREATE TABLE question_editorial_curation (
        question_id INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE RESTRICT,
        batch_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('held', 'pilot')),
        stage TEXT CHECK(stage IN ('prerequisite', 'application', 'reasoning', 'practice', 'verification')),
        family TEXT,
        reason TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        rationales_json TEXT CHECK(rationales_json IS NULL OR json_valid(rationales_json)),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK((state = 'held' AND stage IS NULL AND family IS NULL AND rationales_json IS NULL)
          OR (state = 'pilot' AND stage IS NOT NULL AND family IS NOT NULL AND rationales_json IS NOT NULL))
      );
      INSERT INTO feature_flags(flag_key, name, description, master_enabled, default_enabled, rollout_percentage)
      VALUES ('question_bank.editorial_pilot', 'Lote editorial de Matemática',
        'Libera itens do piloto após revisão e ativação individual, conforme a finalidade pedagógica.', 0, 0, 0);
    `);
    installQuestionEditorialPilot(db, {
      holds: '49bf7c97881ba03ac220066783bf837fae67d95aa0ae8355447600b40692adae',
      grade5: '7b93254a438339dfb9d8dc8df62b4e0cd29523974f798550266f10444184a3be',
      grade9: '6166ad3962c3a813533e6ef4552fe4fe225060212084503d1ecb410ba3d8b2ee',
    });
  },
};
