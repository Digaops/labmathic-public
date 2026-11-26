const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');

const config = require('./config');

if (config.isProduction || config.appEnvironment !== 'development') {
  throw new Error('A carga de demonstração só pode ser executada em desenvolvimento.');
}
const db = require('./database');

console.log('🌱 Populando banco de dados...');

// ─── Users ───
const insertUser = db.prepare('INSERT OR IGNORE INTO users (name, email, password, role) VALUES (?, ?, ?, ?)');
const adminPassword = randomBytes(18).toString('base64url');
const teacherPassword = randomBytes(18).toString('base64url');

const adminEmail = 'admin@labmathic.test';
const admin = insertUser.run('Administrador', adminEmail, bcrypt.hashSync(adminPassword, 10), 'admin');
if (admin.changes) console.log('Admin de demonstração:', adminEmail, adminPassword);
const teacherEmail = 'professor@labmathic.test';
const teacher = insertUser.run('Maria Silva', teacherEmail, bcrypt.hashSync(teacherPassword, 10), 'professor');
if (teacher.changes) console.log('Professor de demonstração:', teacherEmail, teacherPassword);


// ─── Disciplines ───
const insertDiscipline = db.prepare('INSERT OR IGNORE INTO disciplines (name) VALUES (?)');
const disciplines = ['Português', 'Matemática', 'História', 'Geografia', 'Ciências', 'Artes', 'Educação Física', 'Inglês', 'Ensino Religioso'];
disciplines.forEach(d => insertDiscipline.run(d));

// ─── Grades ───
const insertGrade = db.prepare('INSERT OR IGNORE INTO grades (name, sort_order) VALUES (?, ?)');
const grades = [
  ['1º Ano - EF', 1], ['2º Ano - EF', 2], ['3º Ano - EF', 3], ['4º Ano - EF', 4], ['5º Ano - EF', 5],
  ['6º Ano - EF', 6], ['7º Ano - EF', 7], ['8º Ano - EF', 8], ['9º Ano - EF', 9],
  ['1º Ano - EM', 10], ['2º Ano - EM', 11], ['3º Ano - EM', 12],
];
grades.forEach(([name, order]) => insertGrade.run(name, order));

// ─── Topics ───
const insertTopic = db.prepare('INSERT OR IGNORE INTO topics (name) VALUES (?)');
const topics = [
  'Frações', 'Leitura', 'Relevo', 'Fotossíntese', 'Geometria', 'Gramática',
  'Revolução Industrial', 'Clima', 'Sistema Solar', 'Pintura', 'Esportes',
  'Números Decimais', 'Interpretação de Texto', 'Brasil Colônia', 'Biomas',
  'Corpo Humano', 'Música', 'Atletismo', 'Verbos', 'Equações',
  'Segunda Guerra Mundial', 'Globalização', 'Ecologia', 'Cores e Formas',
  'Jogos Cooperativos', 'Probabilidade', 'Poesia', 'Independência do Brasil',
];
topics.forEach(t => insertTopic.run(t));

// ─── Material Types ───
const insertType = db.prepare('INSERT OR IGNORE INTO material_types (name, icon) VALUES (?, ?)');
const types = [
  ['Vídeo', 'video'],
  ['Imagem', 'image'],
  ['PDF', 'pdf'],
  ['Documento de Texto', 'document'],
  ['Apresentação', 'presentation'],
];
types.forEach(([name, icon]) => insertType.run(name, icon));

// ─── Sample Materials ───
const insertMaterial = db.prepare(`
  INSERT OR IGNORE INTO materials (title, description, discipline_id, grade_id, material_type_id, file_format, external_url, duration, page_count, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertMT = db.prepare('INSERT OR IGNORE INTO material_topics (material_id, topic_id) VALUES (?, ?)');

const sampleMaterials = [
  {
    title: 'Introdução às Frações',
    description: 'Vídeo explicativo sobre o conceito de frações para turmas do 4º e 5º ano. Aborda conceitos básicos, representação e exemplos do cotidiano.',
    discipline_id: 2, grade_id: 4, type_id: 1, format: 'MP4',
    url: 'https://www.youtube.com/watch?v=example1', duration: '12:30', pages: null,
    topics: [1, 5],
  },
  {
    title: 'Apostila de Gramática - Verbos',
    description: 'Material completo sobre conjugação verbal, tempos e modos. Inclui exercícios práticos e gabarito para o professor.',
    discipline_id: 1, grade_id: 6, type_id: 3, format: 'PDF',
    url: null, duration: null, pages: 24,
    topics: [6, 19],
  },
  {
    title: 'Mapa dos Biomas Brasileiros',
    description: 'Imagem em alta resolução do mapa dos biomas brasileiros com legenda detalhada. Ideal para impressão e uso em sala de aula.',
    discipline_id: 4, grade_id: 7, type_id: 2, format: 'PNG',
    url: null, duration: null, pages: null,
    topics: [15, 23],
  },
  {
    title: 'Apresentação: Sistema Solar',
    description: 'Slides coloridos sobre os planetas do Sistema Solar, suas características e curiosidades. Apresentação pronta para uso em projetor.',
    discipline_id: 5, grade_id: 5, type_id: 5, format: 'PPTX',
    url: null, duration: null, pages: 18,
    topics: [9],
  },
  {
    title: 'Revolução Industrial - Resumo',
    description: 'Documento de texto com resumo didático sobre a Revolução Industrial, incluindo causas, consequências e linha do tempo ilustrada.',
    discipline_id: 3, grade_id: 8, type_id: 4, format: 'DOCX',
    url: null, duration: null, pages: 8,
    topics: [7],
  },
  {
    title: 'Vídeo: Fotossíntese explicada',
    description: 'Animação educativa sobre o processo de fotossíntese. Linguagem acessível para alunos do ensino fundamental.',
    discipline_id: 5, grade_id: 6, type_id: 1, format: 'MP4',
    url: 'https://www.youtube.com/watch?v=example2', duration: '08:45', pages: null,
    topics: [4, 23],
  },
  {
    title: 'Atividades de Leitura e Interpretação',
    description: 'Coletânea de textos com questões de interpretação para o 3º ano do ensino fundamental. Contém 10 textos variados.',
    discipline_id: 1, grade_id: 3, type_id: 3, format: 'PDF',
    url: null, duration: null, pages: 32,
    topics: [2, 13],
  },
  {
    title: 'Geometria Plana - Formas e Ângulos',
    description: 'Material visual sobre formas geométricas planas, cálculo de áreas e ângulos. Com exercícios resolvidos passo a passo.',
    discipline_id: 2, grade_id: 7, type_id: 3, format: 'PDF',
    url: null, duration: null, pages: 16,
    topics: [5, 24],
  },
  {
    title: 'Brasil Colônia - Linha do Tempo',
    description: 'Infográfico interativo da linha do tempo do Brasil Colônia, desde o descobrimento até a independência.',
    discipline_id: 3, grade_id: 7, type_id: 2, format: 'JPG',
    url: null, duration: null, pages: null,
    topics: [14, 28],
  },
  {
    title: 'Jogos Cooperativos na Educação Física',
    description: 'Vídeo demonstrativo com 15 jogos cooperativos para aplicar em aulas de Educação Física. Inclui variações por faixa etária.',
    discipline_id: 7, grade_id: 4, type_id: 1, format: 'MP4',
    url: 'https://www.youtube.com/watch?v=example3', duration: '22:10', pages: null,
    topics: [11, 25],
  },
  {
    title: 'Cores e Técnicas de Pintura',
    description: 'Apresentação sobre teoria das cores, mistura de tintas e técnicas básicas de pintura para aulas de Artes.',
    discipline_id: 6, grade_id: 3, type_id: 5, format: 'PPTX',
    url: null, duration: null, pages: 22,
    topics: [10, 24],
  },
  {
    title: 'Equações do 1º Grau',
    description: 'Material completo sobre equações do primeiro grau com exercícios progressivos, do básico ao avançado.',
    discipline_id: 2, grade_id: 8, type_id: 3, format: 'PDF',
    url: null, duration: null, pages: 20,
    topics: [20],
  },
];

sampleMaterials.forEach(m => {
  const result = insertMaterial.run(m.title, m.description, m.discipline_id, m.grade_id, m.type_id, m.format, m.url, m.duration, m.pages, 1);
  if (result.changes > 0) {
    m.topics.forEach(tid => insertMT.run(result.lastInsertRowid, tid));
  }
});

console.log('✅ Seed concluído!');
console.log('   Usuários de demonstração criados.');
console.log('   Não use credenciais de demonstração em produção.');
