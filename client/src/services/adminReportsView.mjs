export const reportViews = { overview: 'Visão geral', materials: 'Materiais', bank: 'Banco de questões', people: 'Uso por pessoa', accesses: 'Entradas por dia' };
export const reportView = value => Object.hasOwn(reportViews, value) ? value : 'overview';
const number = (value, label, rating = false) => { if (!Number.isFinite(value) || value < 0 || (!rating && !Number.isSafeInteger(value)) || (rating && value > 5)) throw Error('Número inválido: ' + label); return value; };
const counts = (item, fields) => { if (!item || typeof item !== 'object') throw Error('Dados indisponíveis'); fields.forEach(key => number(item[key], key)); return item; };
const list = (items, id, validate) => { if (!Array.isArray(items)) throw Error('Lista indisponível'); const checked = items.map(validate); if (new Set(checked.map(i => i[id])).size !== checked.length) throw Error('Registros repetidos'); return checked; };
const identity = (row, id, name) => { if (!row || !Number.isSafeInteger(row[id]) || row[id] < 1 || typeof row[name] !== 'string' || !row[name].trim()) throw Error('Registro inválido'); return row; };
export const overviewFields = ['totalMaterials', 'totalUsers', 'totalSystemAccesses', 'totalMaterialAccesses', 'totalQuestionSetAccesses', 'totalContentAccesses', 'totalDownloads', 'totalFavorites', 'totalComments', 'totalSupportThreads', 'unreadSupportMessages'];
export function reportOverview(data) { counts(data, overviewFields); number(data.avgRating, 'avgRating', true); return data; }
export const reportMaterials = data => list(data, 'id', row => { identity(row, 'id', 'title'); counts(row, ['access_count']); number(row.avg_rating, 'avg_rating', true); return row; });
export const reportPeople = data => list(data, 'id', row => { identity(row, 'id', 'name'); if (typeof row.email !== 'string') throw Error('E-mail inválido'); return counts(row, ['system_access_count', 'material_access_count', 'question_set_access_count', 'favorites_count', 'comments_count']); });
export const bankGroups = [
  ['Questões', [['total_questions', 'Cadastradas'], ['active_questions', 'Ativas'], ['inactive_questions', 'Inativas'], ['reviewed_questions', 'Revisadas'], ['not_reviewed_questions', 'A revisar']]],
  ['Simulados', [['total_question_sets', 'Cadastrados'], ['public_question_sets', 'Públicos'], ['private_question_sets', 'Privados'], ['total_question_set_items', 'Questões nos simulados'], ['total_question_set_accesses', 'Acessos']]],
  ['Criação pelos professores', [['teacher_questions', 'Questões próprias'], ['teacher_question_creators', 'Autores de questões'], ['teacher_question_sets', 'Simulados com questões próprias'], ['teacher_question_set_creators', 'Autores de simulados'], ['teacher_question_set_accesses', 'Acessos a esses simulados']]],
  ['Diagnósticos por habilidade', [['diagnostic_question_sets', 'Gerados'], ['diagnostic_creators', 'Professores participantes'], ['diagnostic_assignments', 'Aplicações preparadas']]],
];
export function reportBank(data) {
  counts(data?.totals, bankGroups.flatMap(([, fields]) => fields.map(([key]) => key)));
  const authorEngagement = list(data.authorEngagement, 'user_id', row => { identity(row, 'user_id', 'user_name'); if (typeof row.email !== 'string') throw Error('Autor inválido'); return counts(row, ['author_question_count', 'author_set_count', 'author_set_access_count']); });
  return { totals: data.totals, authorEngagement };
}
export function dateOnly(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value; }
export function reportTimeline(data) {
  const rows = list(data, 'date', row => { if (!dateOnly(row?.date)) throw Error('Data inválida'); return counts(row, ['count']); });
  if (rows.some((r, i) => i && r.date <= rows[i - 1].date)) throw Error('Datas fora de ordem');
  return rows;
}
export const shortDay = date => dateOnly(date) ? date.slice(8, 10) + '/' + date.slice(5, 7) + '/' + date.slice(0, 4) : 'Data não informada';
export const csvTypes = { materials: { label: 'Materiais', scope: 'Todos os materiais cadastrados, com classificação e contagem de acessos.' }, users: { label: 'Usuários', scope: 'Todas as contas, com nome, e-mail, perfil e contagens de uso. Não inclui senhas.' }, accesses: { label: 'Acessos a materiais', scope: 'Até 1.000 acessos a materiais, dos mais recentes aos mais antigos, com pessoa e material ainda cadastrados. Não inclui entradas no sistema nem acessos a simulados.' } };
