const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

const projectRoot = path.resolve(__dirname, '../..');
const defaultManifestPath = path.join(projectRoot, 'assets', 'question-images', 'manifest.json');

function parseArgs(argv) {
  const options = {
    apply: false,
    replace: false,
    manifestPath: defaultManifestPath,
    only: null,
  };

  argv.forEach((argument) => {
    if (argument === '--apply') {
      options.apply = true;
      return;
    }
    if (argument === '--replace') {
      options.replace = true;
      return;
    }
    if (argument.startsWith('--manifest=')) {
      options.manifestPath = path.resolve(argument.slice('--manifest='.length));
      return;
    }
    if (argument.startsWith('--only=')) {
      options.only = new Set(
        argument
          .slice('--only='.length)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      );
      return;
    }

    throw new Error(`Argumento desconhecido: ${argument}`);
  });

  return options;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifesto não encontrado: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.images)) {
    throw new Error('Manifesto de imagens inválido ou com versão não suportada.');
  }

  return manifest;
}

function validateCatalogEntry(entry, seenCodes, manifestDir) {
  if (!entry || entry.status !== 'approved') return null;
  if (!/^[A-Z0-9-]+$/.test(entry.question_code || '')) {
    throw new Error(`Código de questão inválido no catálogo: ${entry.question_code || '(vazio)'}`);
  }
  if (seenCodes.has(entry.question_code)) {
    throw new Error(`Código duplicado no catálogo: ${entry.question_code}`);
  }
  seenCodes.add(entry.question_code);

  if (!entry.statement || !entry.file || !/^[a-zA-Z0-9._-]+$/.test(entry.file)) {
    throw new Error(`Entrada incompleta ou nome de arquivo inseguro: ${entry.question_code}`);
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
    throw new Error(`SHA-256 inválido para ${entry.question_code}.`);
  }

  const sourcePath = path.resolve(manifestDir, entry.file);
  if (path.dirname(sourcePath) !== manifestDir) {
    throw new Error(`Arquivo fora do diretório do catálogo: ${entry.file}`);
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Imagem não encontrada para ${entry.question_code}: ${sourcePath}`);
  }

  const actualHash = sha256(sourcePath);
  if (actualHash !== entry.sha256) {
    throw new Error(`Hash divergente para ${entry.question_code}. Esperado ${entry.sha256}, recebido ${actualHash}.`);
  }

  return { ...entry, sourcePath };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);
  const manifestDir = path.dirname(options.manifestPath);
  const seenCodes = new Set();
  const entries = manifest.images
    .map((entry) => validateCatalogEntry(entry, seenCodes, manifestDir))
    .filter(Boolean)
    .filter((entry) => !options.only || options.only.has(entry.question_code));

  if (options.only) {
    const missingCodes = [...options.only].filter((code) => !entries.some((entry) => entry.question_code === code));
    if (missingCodes.length > 0) {
      throw new Error(`Código(s) não encontrado(s) no catálogo aprovado: ${missingCodes.join(', ')}`);
    }
  }
  if (entries.length === 0) {
    throw new Error('Nenhuma imagem aprovada foi selecionada para sincronização.');
  }
  if (!fs.existsSync(config.dbPath)) {
    throw new Error(`Banco não encontrado: ${config.dbPath}`);
  }

  const db = new Database(config.dbPath, { readonly: !options.apply });
  const plans = [];

  try {
    const findQuestion = db.prepare(`
      SELECT id, question_code, statement, image_path
      FROM questions
      WHERE question_code = ?
    `);

    for (const entry of entries) {
      const question = findQuestion.get(entry.question_code);
      if (!question) {
        throw new Error(`Questão não encontrada no banco de destino: ${entry.question_code}`);
      }
      if (normalizeText(question.statement) !== normalizeText(entry.statement)) {
        throw new Error(
          `O enunciado de ${entry.question_code} diverge do catálogo. A sincronização foi interrompida para evitar associação incorreta.`
        );
      }

      const targetPath = path.resolve(config.uploadDir, entry.file);
      if (path.dirname(targetPath) !== path.resolve(config.uploadDir)) {
        throw new Error(`Destino inseguro para ${entry.question_code}.`);
      }

      const targetExists = fs.existsSync(targetPath);
      if (targetExists && sha256(targetPath) !== entry.sha256) {
        throw new Error(
          `Já existe um arquivo diferente com o nome ${entry.file} no destino. Crie uma nova versão no catálogo.`
        );
      }

      const hasDifferentExistingImage = Boolean(question.image_path && question.image_path !== entry.file);
      const protectedExistingImage = hasDifferentExistingImage && !options.replace;

      plans.push({
        entry,
        question,
        targetPath,
        copyNeeded: !targetExists && !protectedExistingImage,
        updateNeeded: question.image_path !== entry.file && !protectedExistingImage,
        status: protectedExistingImage
          ? 'mantida (use --replace para substituir)'
          : question.image_path === entry.file && targetExists
            ? 'já sincronizada'
            : options.apply
              ? 'será aplicada'
              : 'pronta para aplicar',
      });
    }

    console.log(`Modo: ${options.apply ? 'APLICAR' : 'SIMULAÇÃO SEGURA'}`);
    console.log(`Banco: ${config.dbPath}`);
    console.log(`Uploads: ${config.uploadDir}`);
    console.log(`Catálogo: ${options.manifestPath}`);
    console.table(plans.map((plan) => ({
      question_code: plan.entry.question_code,
      current_image: plan.question.image_path || '-',
      catalog_image: plan.entry.file,
      status: plan.status,
    })));

    if (!options.apply) {
      console.log('Nenhuma alteração foi feita. Rode novamente com --apply após revisar o resultado.');
      if (plans.some((plan) => plan.status.startsWith('mantida'))) {
        console.log('Itens com imagem existente só serão substituídos quando --replace também for informado.');
      }
      return;
    }

    const actionablePlans = plans.filter((plan) => plan.copyNeeded || plan.updateNeeded);
    if (actionablePlans.length === 0) {
      console.log('Nenhuma alteração necessária.');
      return;
    }

    fs.mkdirSync(config.uploadDir, { recursive: true });
    const backupDir = path.resolve(
      process.env.QUESTION_IMAGE_BACKUP_DIR || path.join(path.dirname(config.dbPath), 'question-image-sync-backups')
    );
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `question-images-${timestamp()}.json`);
    const backup = {
      created_at: new Date().toISOString(),
      database: config.dbPath,
      uploads: config.uploadDir,
      catalog: options.manifestPath,
      replace_existing: options.replace,
      changes: actionablePlans.map((plan) => ({
        question_code: plan.entry.question_code,
        previous_image_path: plan.question.image_path || null,
        next_image_path: plan.entry.file,
      })),
    };
    fs.writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');

    const createdFiles = [];
    try {
      actionablePlans.forEach((plan) => {
        if (!plan.copyNeeded) return;
        fs.copyFileSync(plan.entry.sourcePath, plan.targetPath, fs.constants.COPYFILE_EXCL);
        createdFiles.push(plan.targetPath);
      });

      const updateQuestion = db.prepare(`
        UPDATE questions
        SET image_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      db.transaction(() => {
        actionablePlans.forEach((plan) => {
          if (plan.updateNeeded) updateQuestion.run(plan.entry.file, plan.question.id);
        });
      })();
    } catch (error) {
      createdFiles.forEach((filePath) => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
      throw error;
    }

    console.log(`Sincronização concluída: ${actionablePlans.length} questão(ões).`);
    console.log(`Backup dos vínculos anteriores: ${backupPath}`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`ERRO: ${error.message}`);
  process.exit(1);
}
