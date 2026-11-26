const Database = require('better-sqlite3');
const config = require('./config');
const { inspectMigrations } = require('./migrations');

function main() {
  const db = new Database(config.dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const status = inspectMigrations(db);
    const integrityCheck = db.pragma('integrity_check', { simple: true });
    const foreignKeyViolations = db.pragma('foreign_key_check');
    const healthy = integrityCheck === 'ok'
      && foreignKeyViolations.length === 0
      && status.changed.length === 0
      && status.unknown.length === 0;

    console.log(JSON.stringify({
      database: config.dbPath,
      healthy,
      integrityCheck,
      foreignKeyViolations: foreignKeyViolations.length,
      migrations: {
        initialized: status.initialized,
        applied: status.applied,
        pending: status.pending,
        changed: status.changed,
        unknown: status.unknown,
      },
    }, null, 2));

    if (!healthy) process.exitCode = 1;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    healthy: false,
    error: error.message,
  }, null, 2));
  process.exitCode = 1;
}
