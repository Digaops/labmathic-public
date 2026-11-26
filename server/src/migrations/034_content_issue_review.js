module.exports = {
  version: 34,
  name: 'content_issue_review',
  description: 'Relatos privados sobre o acervo, revisão responsável e histórico, sem modificar conteúdos aplicados.',
  up(db) {
    db.exec(`
      CREATE TABLE content_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        reporter_id INTEGER NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('question','material')),
        target_id INTEGER NOT NULL CHECK(target_id > 0),
        target_label TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('answer','content','media','accessibility','other')),
        description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 10 AND 2000),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_review','resolved','not_changed')),
        assignee_id INTEGER,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(status = 'open' OR assignee_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX content_issues_active_reporter ON content_issues(reporter_id,target_type,target_id)
        WHERE status IN ('open','in_review');
      CREATE INDEX content_issues_reporter ON content_issues(reporter_id,id DESC);
      CREATE INDEX content_issues_queue ON content_issues(status,id DESC);
      CREATE INDEX content_issues_quota ON content_issues(reporter_id,created_at);
      CREATE TABLE content_issue_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES content_issues(id),
        actor_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('created','claimed','resolved','not_changed')),
        reply TEXT NOT NULL DEFAULT '' CHECK(length(reply) <= 2000),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(issue_id,revision)
      );
      CREATE TRIGGER content_issue_events_no_update BEFORE UPDATE ON content_issue_events
        BEGIN SELECT RAISE(ABORT,'Content issue history is immutable'); END;
      CREATE TRIGGER content_issue_events_no_delete BEFORE DELETE ON content_issue_events
        BEGIN SELECT RAISE(ABORT,'Content issue history is immutable'); END;
      CREATE TABLE content_issue_operations (
        actor_id INTEGER NOT NULL,
        key_hash TEXT NOT NULL CHECK(length(key_hash)=64),
        request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(actor_id,key_hash)
      );
      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES('content.issue_review','Informar problemas no acervo',
          'Relatos privados de professores e fila de revisão administrativa, sem correção automática.',0,0,0);
    `);
  },
};
