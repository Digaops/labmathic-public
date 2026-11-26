module.exports = {
  version: 29,
  name: 'material_bncc_curation',
  description: 'Curadoria administrativa versionada de vínculos BNCC; preserva associações e planos anteriores.',
  up(db) {
    db.exec(`
      CREATE TABLE material_bncc_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_id INTEGER NOT NULL,
        skill_id INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('confirm','remove')),
        reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 20 AND 1000),
        location TEXT NOT NULL CHECK(length(location) <= 160),
        actor_id INTEGER NOT NULL,
        actor_name TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX material_bncc_reviews_material ON material_bncc_reviews(material_id,id DESC);
      CREATE TRIGGER material_bncc_reviews_no_update BEFORE UPDATE ON material_bncc_reviews
        BEGIN SELECT RAISE(ABORT,'Material reviews are immutable'); END;
      CREATE TRIGGER material_bncc_reviews_no_delete BEFORE DELETE ON material_bncc_reviews
        BEGIN SELECT RAISE(ABORT,'Material reviews are immutable'); END;
      CREATE TABLE material_bncc_review_state (
        material_id INTEGER NOT NULL,
        skill_id INTEGER NOT NULL,
        review_id INTEGER REFERENCES material_bncc_reviews(id) ON DELETE SET NULL,
        needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)),
        PRIMARY KEY(material_id,skill_id),
        FOREIGN KEY(material_id,skill_id) REFERENCES material_bncc_skills(material_id,skill_id) ON DELETE CASCADE
      );
      CREATE TABLE material_bncc_operations (
        actor_id INTEGER NOT NULL,
        key_hash TEXT NOT NULL CHECK(length(key_hash)=64),
        request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(actor_id,key_hash)
      );
      CREATE TRIGGER material_bncc_changed_content AFTER UPDATE ON materials
      WHEN NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description
        OR NEW.file_path IS NOT OLD.file_path OR NEW.external_url IS NOT OLD.external_url
        OR NEW.file_format IS NOT OLD.file_format OR NEW.file_size IS NOT OLD.file_size
        OR NEW.discipline_id IS NOT OLD.discipline_id OR NEW.grade_id IS NOT OLD.grade_id
        OR NEW.page_count IS NOT OLD.page_count OR NEW.duration IS NOT OLD.duration
      BEGIN UPDATE material_bncc_review_state SET needs_review=1 WHERE material_id=NEW.id; END;
      CREATE TRIGGER material_bncc_changed_skill AFTER UPDATE ON bncc_skills
      WHEN NEW.code IS NOT OLD.code OR NEW.description IS NOT OLD.description
        OR NEW.grade_id IS NOT OLD.grade_id OR NEW.unit_id IS NOT OLD.unit_id
      BEGIN UPDATE material_bncc_review_state SET needs_review=1 WHERE skill_id=NEW.id; END;
      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES ('materials.bncc_curation','Revisão de habilidades dos materiais',
          'Associação justificada por administrador, sem validar automaticamente a adequação à turma.',0,0,0);
    `);
  },
};
