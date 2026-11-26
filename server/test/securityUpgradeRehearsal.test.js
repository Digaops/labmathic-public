const test = require('node:test');
test('schema 38 recebe atividades numéricas sem alterar dados anteriores', async () => {
  const report = await runSecurityUpgradeRehearsal({fromSchemaVersion:38});
  assert.equal(report.toSchemaVersion,43);assert.equal(report.legacyRowsPreserved,true);assert.equal(report.exactSnapshotRestored,true);
});
test('schema 34 recebe coordenação escolar e devolutiva desligadas, preservando registros e snapshot', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 34 });
  assert.equal(report.toSchemaVersion, 43); assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.featureFlagsPreserved, true); assert.equal(report.exactSnapshotRestored, true);
});
const assert = require('node:assert/strict');
const { runSecurityUpgradeRehearsal } = require('../scripts/ci/securityUpgradeRehearsal');

for (const fromSchemaVersion of [39, 40, 41, 42]) {
  test(`schema ${fromSchemaVersion} migra para 43 e o snapshot restaura o schema anterior`, async () => {
    const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion });
    assert.equal(report.toSchemaVersion, 43);
    assert.equal(report.legacyRowsPreserved, true);
    assert.equal(report.featureFlagsPreserved, true);
    assert.equal(report.exactSnapshotRestored, true);
    assert.equal(report.oldCodeRejectsNewSchema, true);
  });
}

test('schema 37 recebe revisão editorial isolada sem alterar registros ou ativar flags', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 37 });
  assert.equal(report.toSchemaVersion, 43);
  for (const key of ['legacyRowsPreserved','featureFlagsPreserved','submittedScorePreserved','exactSnapshotRestored']) assert.equal(report[key],true,key);
});
test('schema 36 recebe apenas rascunhos numéricos desligados e preserva dados, notas e restauração', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 36 });
  assert.equal(report.toSchemaVersion, 43);
  for (const key of ['legacyRowsPreserved', 'usersAndPasswordsPreserved', 'featureFlagsPreserved', 'submittedScorePreserved', 'exactSnapshotRestored', 'oldCodeRejectsNewSchema']) assert.equal(report[key], true, key);
  assert.equal(report.realDatabaseTouched, false);
});
test('schema 33 recebe revisão de acervo sem alterar dados, notas, flags e snapshot anterior', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 33 });
  assert.equal(report.toSchemaVersion, 43);
  for (const key of ['legacyRowsPreserved', 'usersAndPasswordsPreserved', 'featureFlagsPreserved', 'submittedScorePreserved', 'exactSnapshotRestored', 'oldCodeRejectsNewSchema']) assert.equal(report[key], true, key);
  assert.equal(report.realDatabaseTouched, false);
});

test('schema 32 preserva conteúdo anterior, adiciona telemetria vazia e flag desligada; backup restaura exatamente', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 32 });
  assert.equal(report.toSchemaVersion, 43); assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.exactSnapshotRestored, true); assert.equal(report.oldCodeRejectsNewSchema, true);
});

test('schema 31 recebe autoria assistida desligada, preserva tabelas anteriores e restaura o snapshot', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 31 });
  assert.equal(report.toSchemaVersion, 43); assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.exactSnapshotRestored, true);
});

test('schema 30 recebe Retrato da rede desligado e restaura backup exato sem mudar dados existentes', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 30 });
  assert.equal(report.toSchemaVersion, 43); assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.exactSnapshotRestored, true); assert.equal(report.oldCodeRejectsNewSchema, true);
});

test('schema 29 recebe flag de dispensa desligada e restaura exatamente o backup anterior', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 29 });
  assert.equal(report.toSchemaVersion, 43);
  assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.exactSnapshotRestored, true);
});
test('schema 28 recebe as migrações 29 e 30 e preserva tabelas e flags anteriores', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 28 });
  assert.equal(report.toSchemaVersion, 43); assert.equal(report.legacyRowsPreserved, true); assert.equal(report.exactSnapshotRestored, true);
});

test('schema 27 recebe migrações 28, 29 e 30 sem alterar o acervo e restaura backup exato', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 27 });
  assert.equal(report.toSchemaVersion, 43); assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.exactSnapshotRestored, true); assert.equal(report.oldCodeRejectsNewSchema, true);
});

test('schema 24 populado migra sem perder dados e snapshot restaura o estado anterior', async () => {
  const report = await runSecurityUpgradeRehearsal();
  assert.equal(report.status, 'passed');
  assert.equal(report.fromSchemaVersion, 24);
  assert.equal(report.toSchemaVersion, 43);
  assert.ok(report.tablesCompared > 50);
  assert.ok(report.populatedTables > 15);
  for (const key of ['legacyRowsPreserved', 'usersAndPasswordsPreserved', 'featureFlagsPreserved',
    'submittedScorePreserved', 'migrationHistoryPreserved', 'exactSnapshotRestored', 'oldCodeRejectsNewSchema']) assert.equal(report[key], true, key);
  assert.equal(report.realDatabaseTouched, false);
  assert.equal(report.realUploadsTouched, false);
});

test('schema 25 populado recebe as migrações 26, 27, 28, 29 e 30 e restaura o snapshot exato', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 25 });
  assert.equal(report.status, 'passed');
  assert.equal(report.fromSchemaVersion, 25);
  assert.equal(report.toSchemaVersion, 43);
  assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.featureFlagsPreserved, true);
  assert.equal(report.exactSnapshotRestored, true);
  assert.equal(report.realDatabaseTouched, false);
});

test('schema 26 populado recebe as migrações 27, 28, 29 e 30 e restaura o snapshot exato', async () => {
  const report = await runSecurityUpgradeRehearsal({ fromSchemaVersion: 26 });
  assert.equal(report.status, 'passed');
  assert.equal(report.fromSchemaVersion, 26);
  assert.equal(report.toSchemaVersion, 43);
  assert.equal(report.legacyRowsPreserved, true);
  assert.equal(report.featureFlagsPreserved, true);
  assert.equal(report.exactSnapshotRestored, true);
  assert.equal(report.oldCodeRejectsNewSchema, true);
  assert.equal(report.realDatabaseTouched, false);
});
