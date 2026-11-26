const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure data directory exists
const dataDir = path.dirname(config.dbPath);
if (!config.isProduction && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// A homologação nunca pode inicializar sobre o banco real ou sobre um arquivo
// vazio. A marca é criada exclusivamente pelo sanitizador. Esta verificação
// ocorre em modo somente leitura, antes de WAL, DDL ou qualquer outra escrita.
if (config.appEnvironment === 'homologation') {
  const databaseHeader = Buffer.alloc(20);
  const databaseFile = fs.openSync(config.dbPath, 'r');
  try {
    const bytesRead = fs.readSync(databaseFile, databaseHeader, 0, databaseHeader.length, 0);
    const sqliteSignature = databaseHeader.subarray(0, 16).toString('binary');
    if (bytesRead !== databaseHeader.length || sqliteSignature !== 'SQLite format 3\u0000') {
      throw new Error('Homologação bloqueada: o arquivo informado não é um banco SQLite válido.');
    }
    const validJournalVersions = new Set([1, 2]);
    if (
      !validJournalVersions.has(databaseHeader[18])
      || !validJournalVersions.has(databaseHeader[19])
    ) {
      throw new Error('Homologação bloqueada: o banco usa uma versão de journal SQLite inválida.');
    }
  } finally {
    fs.closeSync(databaseFile);
  }

  const journalSidecarPaths = [`${config.dbPath}-wal`, `${config.dbPath}-shm`];
  const preexistingJournalSidecars = new Set(
    journalSidecarPaths.filter((sidecarPath) => fs.existsSync(sidecarPath))
  );

  for (const sidecarPath of preexistingJournalSidecars) {
    if (fs.lstatSync(sidecarPath).isSymbolicLink()) {
      throw new Error('Homologação bloqueada: o journal SQLite não pode ser um link simbólico.');
    }
  }

  const inspectionDb = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  try {
    const metadataTableExists = inspectionDb.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'homologation_snapshot_metadata'
    `).get();
    const sanitizedMetadata = metadataTableExists
      ? inspectionDb.prepare(`
          SELECT sanitized
          FROM homologation_snapshot_metadata
          WHERE id = 1
        `).get()
      : null;

    if (sanitizedMetadata?.sanitized !== 1) {
      throw new Error('Homologação bloqueada: o banco não possui marca válida de sanitização.');
    }
  } finally {
    inspectionDb.close();
    // O SQLite pode criar sidecars vazios só para ler um arquivo cujo cabeçalho
    // já está em WAL. Removemos apenas os que não existiam antes da inspeção;
    // journals preexistentes podem conter transações válidas e são preservados.
    for (const sidecarPath of journalSidecarPaths) {
      if (!preexistingJournalSidecars.has(sidecarPath) && fs.existsSync(sidecarPath)) {
        const sidecarStats = fs.lstatSync(sidecarPath);
        if (!sidecarStats.isFile() || sidecarStats.isSymbolicLink()) {
          throw new Error('Homologação bloqueada: sidecar SQLite inesperado durante a inspeção.');
        }
        fs.rmSync(sidecarPath, { force: true });
      }
    }
  }

  // Antes de qualquer abertura com escrita, DDL legado ou migração, cria uma
  // cópia consistente e verificada do banco sanitizado. VACUUM INTO usa o
  // snapshot transacional do SQLite e não exige acesso ao banco de produção.
  const { createHomologationPreMigrationSnapshot } = require('./homologationMigrationSnapshot');
  const migrationSnapshot = createHomologationPreMigrationSnapshot({
    appEnvironment: config.appEnvironment,
    databasePath: config.dbPath,
    sourceSha: config.deploymentMetadata?.sourceSha,
  });
  if (migrationSnapshot.status !== 'not-required') {
    console.info(
      `[database] Snapshot de pré-migração ${migrationSnapshot.status} e verificado `
      + `(schema ${migrationSnapshot.schemaVersion} -> ${migrationSnapshot.toSchemaVersion}).`
    );
  }
}

const db = new Database(config.dbPath, { fileMustExist: config.isProduction });

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'professor' CHECK(role IN ('professor', 'admin')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS disciplines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS grades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS material_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    icon TEXT DEFAULT 'file',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    discipline_id INTEGER,
    grade_id INTEGER,
    material_type_id INTEGER,
    file_format TEXT,
    file_path TEXT,
    file_size INTEGER,
    external_url TEXT,
    duration TEXT,
    page_count INTEGER,
    thumbnail_path TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (discipline_id) REFERENCES disciplines(id) ON DELETE SET NULL,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
    FOREIGN KEY (material_type_id) REFERENCES material_types(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS material_topics (
    material_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    PRIMARY KEY (material_id, topic_id),
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS access_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, material_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_public INTEGER DEFAULT 0,
    image_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS collection_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(collection_id, material_id),
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    score INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, material_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    read INTEGER DEFAULT 0,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_materials_discipline ON materials(discipline_id);
  CREATE INDEX IF NOT EXISTS idx_materials_grade ON materials(grade_id);
  CREATE INDEX IF NOT EXISTS idx_materials_type ON materials(material_type_id);
  CREATE INDEX IF NOT EXISTS idx_materials_created_at ON materials(created_at);
  CREATE INDEX IF NOT EXISTS idx_access_history_user ON access_history(user_id);
  CREATE INDEX IF NOT EXISTS idx_access_history_material ON access_history(material_id);
  CREATE INDEX IF NOT EXISTS idx_access_history_user_accessed ON access_history(user_id, accessed_at);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);
  CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
  CREATE INDEX IF NOT EXISTS idx_favorites_material ON favorites(material_id);
  CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);
  CREATE INDEX IF NOT EXISTS idx_collections_public_updated ON collections(is_public, updated_at);
  CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id);
  CREATE INDEX IF NOT EXISTS idx_collection_items_material ON collection_items(material_id);
  CREATE INDEX IF NOT EXISTS idx_ratings_material ON ratings(material_id);
  CREATE INDEX IF NOT EXISTS idx_comments_material ON comments(material_id);
  CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_log_action_created ON activity_log(action, created_at);
  
    -- Banco de Questões - BNCC Units
  CREATE TABLE IF NOT EXISTS bncc_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Banco de Questões - BNCC Skills
  CREATE TABLE IF NOT EXISTS bncc_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    grade_id INTEGER NOT NULL,
    unit_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE,
    FOREIGN KEY (unit_id) REFERENCES bncc_units(id) ON DELETE CASCADE
  );

  -- Banco de Questões - Questions
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_code TEXT NOT NULL UNIQUE,
    skill_id INTEGER NOT NULL,
    statement TEXT NOT NULL,
    support_text TEXT,
    image_path TEXT,
    development_space TEXT NOT NULL DEFAULT 'none' CHECK(development_space IN ('none', 'small', 'medium', 'large')),
    difficulty TEXT NOT NULL DEFAULT 'media' CHECK(difficulty IN ('facil', 'media', 'dificil')),
    question_type TEXT NOT NULL DEFAULT 'multiple_choice',
    official_explanation TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
    reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0, 1)),
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES bncc_skills(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  -- Banco de Questões - Question Options
  CREATE TABLE IF NOT EXISTS question_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    option_label TEXT NOT NULL CHECK(option_label IN ('A', 'B', 'C', 'D')),
    option_text TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0 CHECK(is_correct IN (0, 1)),
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(question_id, option_label),
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
  );

  -- Banco de Questões - Simulados
  CREATE TABLE IF NOT EXISTS question_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    is_public INTEGER DEFAULT 0 CHECK(is_public IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Banco de Questões - Itens dos Simulados
  CREATE TABLE IF NOT EXISTS question_set_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_set_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0,
    show_image INTEGER NOT NULL DEFAULT 1 CHECK(show_image IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(question_set_id, question_id),
    FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_bncc_skills_code ON bncc_skills(code);
  CREATE INDEX IF NOT EXISTS idx_bncc_skills_grade ON bncc_skills(grade_id);
  CREATE INDEX IF NOT EXISTS idx_bncc_skills_unit ON bncc_skills(unit_id);

  CREATE INDEX IF NOT EXISTS idx_questions_code ON questions(question_code);
  CREATE INDEX IF NOT EXISTS idx_questions_skill ON questions(skill_id);
  CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON questions(difficulty);
  CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
  CREATE INDEX IF NOT EXISTS idx_questions_reviewed_status ON questions(reviewed, status);

  CREATE INDEX IF NOT EXISTS idx_question_options_question ON question_options(question_id);
  CREATE INDEX IF NOT EXISTS idx_question_sets_user ON question_sets(user_id);
  CREATE INDEX IF NOT EXISTS idx_question_sets_public ON question_sets(is_public);
  CREATE INDEX IF NOT EXISTS idx_question_set_items_set ON question_set_items(question_set_id);
  CREATE INDEX IF NOT EXISTS idx_question_set_items_question ON question_set_items(question_id);

  -- Banco de Questões - Histórico de acesso aos simulados
  CREATE TABLE IF NOT EXISTS question_set_access_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question_set_id INTEGER NOT NULL,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_question_set_access_user ON question_set_access_history(user_id);
  CREATE INDEX IF NOT EXISTS idx_question_set_access_set ON question_set_access_history(question_set_id);
  CREATE INDEX IF NOT EXISTS idx_question_set_access_date ON question_set_access_history(accessed_at);

  -- Canal direto entre professores e administração
  CREATE TABLE IF NOT EXISTS support_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id INTEGER NOT NULL,
    subject TEXT NOT NULL DEFAULT 'Outro assunto',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
    last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(professor_id, subject),
    FOREIGN KEY (professor_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES support_threads(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_support_threads_professor ON support_threads(professor_id);
  CREATE INDEX IF NOT EXISTS idx_support_threads_last_message ON support_threads(last_message_at);
  CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_support_messages_unread ON support_messages(thread_id, read_at);

  -- Avisos de novidades exibidos por acesso
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    announcement_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all' CHECK(audience IN ('all', 'professor', 'admin')),
    max_impressions INTEGER NOT NULL DEFAULT 1 CHECK(max_impressions > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS announcement_impressions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    announcement_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    access_key TEXT NOT NULL,
    shown_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(announcement_id, user_id, access_key),
    FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_announcements_active_audience
    ON announcements(active, audience);
  CREATE INDEX IF NOT EXISTS idx_announcement_impressions_user
    ON announcement_impressions(user_id, announcement_id);

`);



// Lightweight migrations for existing SQLite databases
const collectionColumns = db.pragma('table_info(collections)').map((column) => column.name);

if (!collectionColumns.includes('image_path')) {
  db.prepare(`
    ALTER TABLE collections
    ADD COLUMN image_path TEXT
  `).run();
}

const questionColumns = db.pragma('table_info(questions)').map((column) => column.name);

if (!questionColumns.includes('image_path')) {
  db.prepare(`
    ALTER TABLE questions
    ADD COLUMN image_path TEXT
  `).run();
}

if (!questionColumns.includes('reviewed')) {
  db.prepare(`
    ALTER TABLE questions
    ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0, 1))
  `).run();
}

if (!questionColumns.includes('development_space')) {
  db.prepare(`
    ALTER TABLE questions
    ADD COLUMN development_space TEXT NOT NULL DEFAULT 'none' CHECK(development_space IN ('none', 'small', 'medium', 'large'))
  `).run();
}

if (!questionColumns.includes('source')) {
  db.prepare(`
    ALTER TABLE questions
    ADD COLUMN source TEXT NOT NULL DEFAULT 'official'
  `).run();
}

const questionSetColumns = db.pragma('table_info(question_sets)').map((column) => column.name);

if (!questionSetColumns.includes('contains_author_questions')) {
  db.prepare(`
    ALTER TABLE question_sets
    ADD COLUMN contains_author_questions INTEGER NOT NULL DEFAULT 0
  `).run();
}

const questionSetItemColumns = db.pragma('table_info(question_set_items)').map((column) => column.name);

if (!questionSetItemColumns.includes('show_image')) {
  db.prepare(`
    ALTER TABLE question_set_items
    ADD COLUMN show_image INTEGER NOT NULL DEFAULT 1 CHECK(show_image IN (0, 1))
  `).run();
}

// A primeira versão do Fale Conosco permitia somente uma conversa por
// professor e apenas alterava o assunto dessa conversa. A estrutura atual
// preserva o histórico existente e permite um atendimento independente para
// cada combinação de professor e assunto.
const supportThreadTable = db.prepare(`
  SELECT sql
  FROM sqlite_master
  WHERE type = 'table' AND name = 'support_threads'
`).get();

const hasLegacySupportThreadConstraint = /professor_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i
  .test(supportThreadTable?.sql || '');

if (hasLegacySupportThreadConstraint) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE support_threads_by_subject (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          professor_id INTEGER NOT NULL,
          subject TEXT NOT NULL DEFAULT 'Outro assunto',
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
          last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(professor_id, subject),
          FOREIGN KEY (professor_id) REFERENCES users(id) ON DELETE CASCADE
        );

        INSERT INTO support_threads_by_subject (
          id, professor_id, subject, status,
          last_message_at, created_at, updated_at
        )
        SELECT
          id,
          professor_id,
          CASE
            WHEN subject IN (
              'Sugestão',
              'Dúvida sobre o sistema',
              'Solicitação de conteúdo',
              'Problema técnico',
              'Outro assunto'
            ) THEN subject
            ELSE 'Outro assunto'
          END,
          status,
          last_message_at, created_at, updated_at
        FROM support_threads;

        DROP TABLE support_threads;
        ALTER TABLE support_threads_by_subject RENAME TO support_threads;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_support_threads_professor ON support_threads(professor_id);
  CREATE INDEX IF NOT EXISTS idx_support_threads_last_message ON support_threads(last_message_at);
  CREATE INDEX IF NOT EXISTS idx_support_threads_subject ON support_threads(subject, last_message_at);
`);

// Bancos antigos podem conter relações órfãs criadas antes da ativação das
// chaves estrangeiras. O schema define ON DELETE CASCADE para estes registros,
// portanto eles não têm utilidade sem o material de origem.
const cleanupOrphanedMaterialRelations = db.transaction(() => {
  db.prepare(`
    DELETE FROM access_history
    WHERE NOT EXISTS (
      SELECT 1 FROM materials WHERE materials.id = access_history.material_id
    )
  `).run();

  db.prepare(`
    DELETE FROM ratings
    WHERE NOT EXISTS (
      SELECT 1 FROM materials WHERE materials.id = ratings.material_id
    )
  `).run();

  db.prepare(`
    DELETE FROM comments
    WHERE NOT EXISTS (
      SELECT 1 FROM materials WHERE materials.id = comments.material_id
    )
  `).run();
});

cleanupOrphanedMaterialRelations();

const activityLogColumns = db.pragma('table_info(activity_log)').map((column) => column.name);

function addActivityLogColumn(name, definition) {
  if (!activityLogColumns.includes(name)) {
    db.prepare(`ALTER TABLE activity_log ADD COLUMN ${name} ${definition}`).run();
    activityLogColumns.push(name);
  }
}

addActivityLogColumn('user_name', 'TEXT');
addActivityLogColumn('user_role', 'TEXT');
addActivityLogColumn('module', 'TEXT');
addActivityLogColumn('entity_title', 'TEXT');
addActivityLogColumn('description', 'TEXT');
addActivityLogColumn('metadata_json', 'TEXT');
addActivityLogColumn('ip_address', 'TEXT');
addActivityLogColumn('user_agent', 'TEXT');
addActivityLogColumn('is_critical', 'INTEGER DEFAULT 0');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON activity_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_log_module ON activity_log(module);
  CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
  CREATE INDEX IF NOT EXISTS idx_activity_log_entity_type ON activity_log(entity_type);
  CREATE INDEX IF NOT EXISTS idx_activity_log_entity_id ON activity_log(entity_id);
  CREATE INDEX IF NOT EXISTS idx_activity_log_critical ON activity_log(is_critical);
  CREATE INDEX IF NOT EXISTS idx_questions_source_creator ON questions(source, created_by);
  CREATE INDEX IF NOT EXISTS idx_question_sets_author_content ON question_sets(contains_author_questions, user_id);
`);

const productUpdatePayload = JSON.stringify({
  intro: 'Temos duas novidades para facilitar seu planejamento e seu contato com a equipe.',
  features: [
    {
      key: 'author_questions',
      title: 'Crie suas próprias questões',
      description: 'Agora você pode criar questões autorais e usá-las em seus simulados. Elas são exclusivas para você entre os professores; somente você e os administradores do sistema poderão consultá-las.',
      actionLabel: 'Criar questão autoral',
      actionPath: '/banco-questoes?tab=author&create=1',
    },
    {
      key: 'support',
      title: 'Novo canal Fale Conosco',
      description: 'Envie dúvidas, sugestões ou pedidos de apoio sobre o uso da plataforma e converse diretamente com a equipe LabMathic.',
      actionLabel: 'Conhecer o Fale Conosco',
      actionPath: '/fale-conosco',
    },
  ],
});

db.prepare(`
  INSERT INTO announcements (
    announcement_key,
    title,
    payload_json,
    audience,
    max_impressions,
    active
  )
  VALUES (?, ?, ?, 'professor', 2, 1)
  ON CONFLICT(announcement_key) DO UPDATE SET
    title = excluded.title,
    payload_json = excluded.payload_json,
    audience = excluded.audience,
    max_impressions = excluded.max_impressions,
    active = excluded.active,
    updated_at = CURRENT_TIMESTAMP
`).run(
  'author_questions_and_support_launch_2026_08',
  'Novidades no LabMathic',
  productUpdatePayload
);

// A partir desta baseline, toda nova alteracao de schema deve ser criada em
// server/src/migrations. As compatibilizacoes acima permanecem temporariamente
// para atualizar bancos anteriores a v1.4.1 antes do inicio do historico formal.
const { runMigrations } = require('./migrations');
runMigrations(db, { institutionalFingerprintSecret: config.jwtSecret });

module.exports = db;
