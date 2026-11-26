const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => Number.isSafeInteger(value) && value > 0;
const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const need = (ok, message = 'Os dados recebidos estão incompletos. Atualize a consulta.') => { if (!ok) throw Error(message); };
const roles = { teacher: 'Professor(a)', school_coordinator: 'Coordenação escolar', school_manager: 'Gestão escolar', municipal_manager: 'Gestão municipal' };
export const operationTypes = { municipality: 'create_municipality', school: 'create_school', membership: 'create_membership', professional: 'create_professional', class: 'create_guided_class', confirmation: 'confirm_guided_class' };

function rows(value, key, validate) {
  need(Array.isArray(value)); const seen = new Set();
  value.forEach(item => { need(object(item) && (key === 'id' ? id(item[key]) : text(item[key])) && !seen.has(item[key])); seen.add(item[key]); validate(item); });
}
function guided(row) {
  need(text(row.name) && id(row.academicYear) && object(row.grade) && id(row.grade.id) && text(row.grade.name) && object(row.teacher) && id(row.teacher.id) && text(row.teacher.name) && text(row.schoolName) && text(row.schoolPublicId) && text(row.municipalityName) && text(row.municipalityPublicId) && ['linked', 'verified'].includes(row.migrationStatus) && text(row.contextUpdatedAt));
}
export function managementState(value, user) {
  need(object(value) && value.writable === true && value.environment === 'homologation' && value.mode === (user.role === 'admin' ? 'admin' : 'professional'));
  rows(value.guidedClasses, 'publicId', guided);
  if (value.mode === 'professional') { rows(value.pendingConfirmations, 'publicId', item => { guided(item); need(item.teacher.id === user.id && item.migrationStatus === 'linked'); }); need(value.guidedClasses.every(item => item.teacher.id === user.id)); return value; }
  rows(value.municipalities, 'publicId', item => need(text(item.name) && ['active', 'archived'].includes(item.status)));
  rows(value.schools, 'publicId', item => need(text(item.name) && text(item.municipalityPublicId) && ['active', 'archived'].includes(item.status)));
  rows(value.professionals, 'id', item => need(text(item.name) && text(item.email)));
  const membership = item => need(id(item.userId) && text(item.professionalName) && text(item.professionalEmail) && Object.hasOwn(roles, item.role) && text(item.municipalityPublicId) && (item.schoolPublicId === null || text(item.schoolPublicId)) && text(item.status));
  rows(value.memberships, 'publicId', membership); rows(value.teacherMemberships, 'publicId', item => { membership(item); need(item.role === 'teacher' && item.status === 'active'); });
  for (const list of [value.grades, value.disciplines]) rows(list, 'id', item => need(text(item.name)));
  return value;
}

export function prepareInstitutionalWrite(state, command) {
  const data = structuredClone(command.data), kind = command.action.startsWith('confirm-') ? 'confirmation' : command.action;
  need(Object.hasOwn(operationTypes, kind), 'Operação não reconhecida.');
  const summary = [], expected = {};
  const add = (label, value) => summary.push([label, value]);
  const name = (max, label) => { const value = clean(data.name); need(value.length >= 2 && value.length <= max && !/[\u0000-\u001F]/.test(String(data.name)), `Confira ${label}.`); add(label, value); return value; };
  const scope = (municipalityId, schoolId, schoolRequired) => {
    const municipality = state.municipalities.find(item => item.publicId === municipalityId && item.status === 'active');
    need(municipality, 'Escolha um município ativo.'); add('Município', municipality.name); expected.municipalityPublicId = municipality.publicId;
    if (schoolRequired) { const school = state.schools.find(item => item.publicId === schoolId && item.municipalityPublicId === municipalityId && item.status === 'active'); need(school, 'Escolha uma escola deste município.'); add('Escola', school.name); expected.schoolPublicId = school.publicId; }
    else expected.schoolPublicId = null;
  };
  if (kind === 'confirmation') {
    const item = state.pendingConfirmations.find(item => `confirm-${item.publicId}` === command.action);
    need(item && item.contextUpdatedAt === data.expectedContextUpdatedAt, 'Atualize a consulta antes de confirmar esta turma.');
    need(command.url === `/institutions/management/classes/${item.publicId}/confirm`);
    add('Turma', item.name); add('Município', item.municipalityName); add('Escola', item.schoolName); add('Ano escolar', item.grade.name); add('Ano letivo', String(item.academicYear)); expected.publicId = item.publicId;
  } else {
    need(state.mode === 'admin', 'Esta ação exige acesso administrativo.');
    if (kind === 'municipality') { expected.name = name(160, 'Nome do município'); const code = clean(data.ibgeCode); need(!code || /^\d{7}$/.test(code), 'O código IBGE deve ter sete números.'); add('Código IBGE', code || 'Não informado'); expected.ibgeCode = code || null; need(command.url === '/institutions/management/municipalities'); }
    if (kind === 'school') { expected.name = name(180, 'Nome da escola'); const municipalityId = command.url.split('/')[4]; scope(municipalityId, null, false); need(command.url === `/institutions/management/municipalities/${municipalityId}/schools`); add('Código Inep', clean(data.censusCode) || 'Não informado'); expected.censusCode = clean(data.censusCode) || null; }
    if (kind === 'membership' || kind === 'professional') {
      need(Object.hasOwn(roles, data.role), 'Escolha uma função na rede.');
      if (kind === 'membership') { const user = state.professionals.find(item => item.id === data.userId); need(user, 'Escolha uma conta profissional.'); add('Profissional', user.name); add('E-mail', user.email); expected.userId = user.id; need(command.url === '/institutions/management/memberships'); }
      else { expected.name = name(100, 'Nome'); expected.email = clean(data.email).toLowerCase(); need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expected.email), 'Confira o e-mail.'); need(typeof data.temporaryPassword === 'string' && data.temporaryPassword.trim().length >= 10 && data.temporaryPassword.length <= 200, 'Use uma senha temporária com pelo menos 10 caracteres.'); add('E-mail', expected.email); need(command.url === '/institutions/management/professionals'); }
      add('Função', roles[data.role]); expected.role = data.role; scope(data.municipalityPublicId, data.schoolPublicId, data.role !== 'municipal_manager');
    }
    if (kind === 'class') {
      expected.name = name(120, 'Nome da turma'); const membership = state.teacherMemberships.find(item => item.publicId === data.membershipPublicId);
      need(membership, 'Escolha o professor e a escola.'); scope(membership.municipalityPublicId, membership.schoolPublicId, true); add('Professor(a)', membership.professionalName); expected.userId = membership.userId;
      const grade = state.grades.find(item => item.id === data.gradeId); need(grade, 'Escolha o ano escolar.'); add('Ano escolar', grade.name); expected.gradeId = grade.id;
      need(id(data.academicYear) && data.academicYear >= 2000 && data.academicYear <= new Date().getFullYear() + 5, 'Confira o ano letivo.'); add('Ano letivo', String(data.academicYear)); expected.academicYear = data.academicYear;
      need(Array.isArray(data.disciplineIds) && data.disciplineIds.length > 0 && data.disciplineIds.length <= 10 && new Set(data.disciplineIds).size === data.disciplineIds.length, 'Escolha de um a dez componentes curriculares.');
      const disciplines = data.disciplineIds.map(id => state.disciplines.find(item => item.id === id)); need(disciplines.every(Boolean), 'Confira os componentes curriculares.'); add('Componentes', disciplines.map(item => item.name).join(' · ')); need(command.url === '/institutions/management/classes');
    }
  }
  return { ...command, data, kind, expected, summary };
}

export function institutionalWriteResult(operation, value) {
  need(object(value) && typeof value.replayed === 'boolean'); const e = operation.expected;
  const entity = value[({ municipality: 'municipality', school: 'school', membership: 'membership', professional: 'membership', class: 'schoolClass', confirmation: 'schoolClass' })[operation.kind]];
  need(object(entity) && text(entity.publicId));
  if (operation.kind === 'municipality') need(entity.name === e.name && entity.ibgeCode === e.ibgeCode);
  if (operation.kind === 'school') need(entity.name === e.name && entity.municipalityPublicId === e.municipalityPublicId && entity.censusCode === e.censusCode);
  if (['membership', 'professional'].includes(operation.kind)) {
    need(entity.role === e.role && entity.municipalityPublicId === e.municipalityPublicId && entity.schoolPublicId === e.schoolPublicId && entity.status === 'active');
    if (operation.kind === 'membership') need(entity.userId === e.userId);
    else need(object(value.professional) && id(value.professional.id) && entity.userId === value.professional.id && value.professional.name === e.name && value.professional.email === e.email);
  }
  if (operation.kind === 'class') need(entity.name === e.name && entity.teacher?.id === e.userId && entity.grade?.id === e.gradeId && entity.academicYear === e.academicYear && entity.schoolPublicId === e.schoolPublicId && entity.municipalityPublicId === e.municipalityPublicId && entity.migrationStatus === 'linked');
  if (operation.kind === 'confirmation') need(entity.publicId === e.publicId && entity.migrationStatus === 'verified');
  return value;
}

export function institutionalReceipt(operation, value) {
  need(object(value) && typeof value.found === 'boolean');
  if (!value.found) return null;
  need(value.operationType === operationTypes[operation.kind]); return institutionalWriteResult(operation, value.result);
}
export function institutionalError(error) { const message = error?.response?.data?.error; return typeof message === 'string' ? message : 'Não foi possível concluir a consulta. Tente novamente.'; }
