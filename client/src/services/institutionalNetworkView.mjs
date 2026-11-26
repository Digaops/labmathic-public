const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const optionalText = value => value === null || text(value);
function requireValue(ok) { if (!ok) throw new Error('Resposta institucional incompleta.'); }
function counts(value, keys) { requireValue(object(value) && keys.every(key => count(value[key]))); }
function rows(value, validate) {
  requireValue(Array.isArray(value));
  const ids = new Set();
  for (const row of value) {
    requireValue(object(row) && text(row.publicId) && !ids.has(row.publicId));
    ids.add(row.publicId); validate(row);
  }
}

export function institutionalModel(value, role) {
  requireValue(object(value) && value.readOnly === true && ['admin', 'manager', 'professional'].includes(value.mode));
  requireValue(role === 'admin' ? value.mode === 'admin' : role === 'professor' && value.mode !== 'admin');
  if (value.mode === 'professional') {
    requireValue(['verified_context', 'awaiting_verification', 'membership_ready', 'pending_institutional_link', 'no_context'].includes(value.status));
    counts(value.summary, ['memberships', 'classes', 'verifiedClasses', 'linkedClasses', 'pendingClasses']);
    rows(value.memberships, row => requireValue(text(row.role) && text(row.roleLabel) && text(row.municipalityPublicId) && text(row.municipalityName) && optionalText(row.schoolPublicId) && optionalText(row.schoolName)));
    rows(value.classes, row => requireValue(text(row.name) && Number.isInteger(row.academicYear) && ['active', 'archived'].includes(row.status) && ['pending', 'linked', 'verified'].includes(row.migrationStatus) && optionalText(row.gradeName) && optionalText(row.schoolName) && optionalText(row.municipalityName)));
  } else {
    counts(value.summary, ['activeMunicipalities', 'activeSchools', 'linkedProfessionals', 'verifiedClasses']);
    if (value.mode === 'admin') {
      counts(value.summary, ['pendingClasses', 'linkedClasses']);
      counts(value.summary.roleCoverage, ['municipalManagers', 'schoolManagers', 'schoolCoordinators', 'teachers']);
    } else requireValue(['municipality', 'school', 'mixed'].includes(value.scopeLevel));
    const schools = new Set();
    rows(value.municipalities, row => {
      requireValue(text(row.name) && row.status === 'active');
      counts(row, ['professionalCount']);
      if (value.mode === 'manager') requireValue(['municipality', 'schools'].includes(row.accessLevel) && Array.isArray(row.roleLabels) && row.roleLabels.every(text));
      rows(row.schools, school => {
        requireValue(text(school.name) && school.status === 'active' && !schools.has(school.publicId)); schools.add(school.publicId);
        counts(school, ['professionalCount', 'teacherCount', 'leadershipCount', 'verifiedClassCount']);
      });
    });
  }
  return value;
}

export const normalizedNetworkText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR');

// Filtering never changes the server totals or invents schools outside the authorized response.
export function networkResults(municipalities, query = '', municipalityId = '') {
  const needle = normalizedNetworkText(query);
  return [...municipalities].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base', numeric: true }) || a.publicId.localeCompare(b.publicId)).filter(item => !municipalityId || item.publicId === municipalityId).flatMap(item => {
    if (!needle || normalizedNetworkText(item.name).includes(needle)) return [{ ...item, visibleSchools: item.schools }];
    const visibleSchools = item.schools.filter(school => normalizedNetworkText(school.name).includes(needle));
    return visibleSchools.length ? [{ ...item, visibleSchools }] : [];
  });
}
