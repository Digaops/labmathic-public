const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const test = require('node:test');
const migration011 = require('../src/migrations/011_balanced_assessment_answer_keys');

function databaseBeforeMigration() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE question_set_items (
      id INTEGER PRIMARY KEY,
      question_set_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      show_image INTEGER NOT NULL
    );
    INSERT INTO question_set_items VALUES (1, 10, 100, 1, 1);
  `);
  return db;
}

test('migração 011 é aditiva e não reescreve a apresentação de simulados existentes', () => {
  const db = databaseBeforeMigration();
  migration011.up(db);

  const legacy = db.prepare('SELECT * FROM question_set_items WHERE id = 1').get();
  assert.equal(legacy.option_order, null);
  db.prepare(`
    INSERT INTO question_set_items
      (id, question_set_id, question_id, sort_order, show_image, option_order)
    VALUES (2, 10, 101, 2, 1, 'CADB')
  `).run();
  assert.equal(
    db.prepare('SELECT option_order FROM question_set_items WHERE id = 2').pluck().get(),
    'CADB'
  );
  db.close();
});

test('banco recusa ordem que não seja uma permutação completa de A, B, C e D', () => {
  const db = databaseBeforeMigration();
  migration011.up(db);

  for (const invalid of ['AAAA', 'ABC', 'ABCDE', 'ABCC']) {
    assert.throws(() => db.prepare(`
      INSERT INTO question_set_items
        (id, question_set_id, question_id, sort_order, show_image, option_order)
      VALUES (2, 10, 101, 2, 1, ?)
    `).run(invalid), /CHECK constraint failed/);
  }
  db.close();
});
