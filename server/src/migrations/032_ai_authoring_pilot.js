module.exports = {
  version: 32,
  name: 'ai_authoring_pilot',
  description: 'Autoria assistida isolada, cotas persistentes, idempotência e revisão humana; desligada por padrão.',
  up(db) {
    db.exec(`
      CREATE TABLE ai_authoring_requests (
        public_id TEXT PRIMARY KEY,
        teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        brief_json TEXT NOT NULL CHECK(json_valid(brief_json)),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing','succeeded','failed','cancelled','expired')),
        suggestion_json TEXT CHECK(suggestion_json IS NULL OR json_valid(suggestion_json)),
        failure_code TEXT,
        reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0),
        input_tokens INTEGER, output_tokens INTEGER,
        created_at INTEGER NOT NULL,
        completed_at INTEGER, reviewed_at INTEGER,
        UNIQUE(teacher_id,idempotency_key)
      );
      CREATE INDEX ai_authoring_budget ON ai_authoring_requests(created_at,teacher_id);
      CREATE TABLE ai_authoring_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES ai_authoring_requests(public_id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('reserved','succeeded','failed','cancelled','expired','reviewed')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE ai_authoring_question_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES ai_authoring_requests(public_id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        saved_content_json TEXT NOT NULL CHECK(json_valid(saved_content_json)),
        saved_at INTEGER NOT NULL
      );
      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES('question_bank.ai_assistant','Ajuda de IA na autoria','Sugestões privadas com revisão do professor e limites de uso.',0,0,0);
    `);
  },
};
