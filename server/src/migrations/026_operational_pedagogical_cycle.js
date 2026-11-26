module.exports = {
  version: 26,
  name: 'operational_pedagogical_cycle',
  description: 'Ciclo docente com devolutivas versionadas, isoladas dos resultados originais e desligado por padrao.',
  up(db) {
    db.exec(`
      CREATE TABLE pedagogical_feedback_versions (
        id INTEGER PRIMARY KEY,
        assignment_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        request_key TEXT NOT NULL CHECK(length(request_key) = 64),
        request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
        evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        objective TEXT NOT NULL CHECK(length(objective) BETWEEN 10 AND 2000),
        observation TEXT NOT NULL CHECK(length(observation) BETWEEN 10 AND 2000),
        action TEXT NOT NULL CHECK(length(action) BETWEEN 10 AND 2000),
        verification TEXT NOT NULL CHECK(length(verification) BETWEEN 10 AND 2000),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(assignment_id, revision),
        UNIQUE(owner_teacher_id, request_key),
        FOREIGN KEY (assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_assignments(id, class_id, owner_teacher_id) ON DELETE RESTRICT
      );
      CREATE TRIGGER pedagogical_feedback_prevent_update
        BEFORE UPDATE ON pedagogical_feedback_versions
        BEGIN SELECT RAISE(ABORT, 'Feedback revisions are immutable'); END;
      CREATE TRIGGER pedagogical_feedback_prevent_delete
        BEFORE DELETE ON pedagogical_feedback_versions
        BEGIN SELECT RAISE(ABORT, 'Feedback revisions are immutable'); END;
      INSERT INTO feature_flags (
        flag_key, name, description, release_id, master_enabled, default_enabled, rollout_percentage
      ) SELECT 'pedagogy.operational_cycle', 'Banco 2.0 e ciclo de devolutivas reais',
        'Conecta turma, diagnostico, devolutiva docente, intervencao e verificacao; sem publicar para estudantes.',
        id, 0, 0, 0 FROM product_releases WHERE version = '2.2.0';
    `);
  },
};
