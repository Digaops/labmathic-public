module.exports = {
  version: 33,
  name: 'ai_usage_foundation',
  description: 'Uso de IA sem conteúdo, reservas de orçamento, cotas persistentes e liberação isolada.',
  up(db) {
    db.exec(`
      CREATE TABLE ai_usage_events (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        questions_requested INTEGER NOT NULL CHECK(questions_requested BETWEEN 1 AND 5),
        status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','failed')),
        success INTEGER NOT NULL DEFAULT 0 CHECK(success IN (0,1)),
        error_type TEXT,
        input_tokens INTEGER CHECK(input_tokens >= 0),
        cached_input_tokens INTEGER CHECK(cached_input_tokens >= 0),
        cache_write_tokens INTEGER CHECK(cache_write_tokens >= 0),
        output_tokens INTEGER CHECK(output_tokens >= 0),
        total_tokens INTEGER CHECK(total_tokens >= 0),
        reserved_cost_nanos INTEGER NOT NULL CHECK(reserved_cost_nanos >= 0),
        estimated_cost_nanos INTEGER CHECK(estimated_cost_nanos >= 0),
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(user_id,idempotency_key)
      );
      CREATE INDEX ai_usage_user_time ON ai_usage_events(user_id,created_at);
      CREATE INDEX ai_usage_time ON ai_usage_events(created_at);
      CREATE TABLE ai_budget_months (
        month TEXT PRIMARY KEY,
        peak_alert_level INTEGER NOT NULL CHECK(peak_alert_level IN (0,70,90,100)),
        committed_cost_nanos INTEGER NOT NULL,
        budget_nanos INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES('ai.questions_generation','Assistente LabMathic: geração textual','Fundação Luna com revisão humana, cotas e orçamento; sem publicação automática.',0,0,0);
    `);
  },
};
