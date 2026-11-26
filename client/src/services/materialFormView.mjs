const id = value => Number.isSafeInteger(value) && value > 0;
const version = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function materialOptions(value) {
  if (!Array.isArray(value) || value.some(v => !v || !id(v.id) || typeof v.name !== 'string' || !v.name.trim()) || new Set(value.map(v => v.id)).size !== value.length) throw Error('Opções inválidas.');
  return value;
}
export function materialSnapshot(value, expectedId) {
  const m = value?.material;
  if (!m || !id(m.id) || m.id !== Number(expectedId) || typeof m.title !== 'string' || !m.title.trim() || !version(value.version)) throw Error('Material não confirmado.');
  for (const key of ['discipline_id', 'grade_id', 'material_type_id']) if (m[key] != null && !id(m[key])) throw Error('Classificação inválida.');
  for (const key of ['description', 'file_path', 'file_format', 'external_url', 'duration']) if (m[key] != null && typeof m[key] !== 'string') throw Error('Dados incompletos.');
  for (const key of ['page_count', 'file_size']) if (m[key] != null && (!Number.isSafeInteger(m[key]) || m[key] < 0)) throw Error('Dados incompletos.');
  materialOptions(value.topics); materialOptions(value.collections);
  if (!Number.isSafeInteger(value.otherCollectionCount) || value.otherCollectionCount < 0) throw Error('Vínculos incompletos.');
  return value;
}
export function materialDraft(snapshot) {
  const m = snapshot?.material || {};
  return { title: m.title || '', description: m.description || '', discipline_id: String(m.discipline_id ?? ''), grade_id: String(m.grade_id ?? ''), material_type_id: String(m.material_type_id ?? ''),
    external_url: m.external_url || '', duration: m.duration || '', page_count: String(m.page_count ?? ''), topicIds: snapshot?.topics.map(t => t.id) || [], addCollectionIds: [], replaceFile: false };
}
export function materialFormError(form, file, snapshot) {
  if (!form.title.trim() || form.title.length > 200) return ['title', 'Informe um título com até 200 caracteres.'];
  if (form.description.length > 5000) return ['description', 'A descrição pode ter até 5000 caracteres.'];
  for (const key of ['discipline_id', 'grade_id', 'material_type_id']) if (form[key] && (!/^\d+$/.test(form[key]) || !id(Number(form[key])))) return [key, 'Confira a classificação.'];
  if (form.external_url.trim()) {
    let url; try { url = new URL(form.external_url.trim()); } catch { return ['external_url', 'Use um link completo, começando com http:// ou https://.']; }
    if (form.external_url.length > 2000 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ['external_url', 'Use um link HTTP ou HTTPS sem credenciais.'];
  }
  if (form.duration.length > 80) return ['duration', 'Descreva a duração em até 80 caracteres.'];
  if (form.page_count && (!/^\d+$/.test(form.page_count) || !Number.isSafeInteger(Number(form.page_count)) || Number(form.page_count) > 100000)) return ['page_count', 'Informe de 0 a 100000 páginas, ou deixe em branco.'];
  if (file && snapshot?.material.file_path && !form.replaceFile) return ['replaceFile', 'Confirme a substituição do arquivo atual antes de salvar.'];
  return null;
}
export function materialPayload(form, snapshot) {
  return { ...form, title: form.title.trim(), discipline_id: form.discipline_id ? Number(form.discipline_id) : null, grade_id: form.grade_id ? Number(form.grade_id) : null,
    material_type_id: form.material_type_id ? Number(form.material_type_id) : null, page_count: form.page_count === '' ? null : Number(form.page_count), expectedVersion: snapshot?.version || null };
}
export function materialReceipt(value, key, targetId) {
  if (!value || value.operationKey !== key || value.operation !== (targetId ? 'update' : 'create') || !id(value.materialId) || (targetId && value.materialId !== Number(targetId))
    || typeof value.title !== 'string' || !value.title.trim() || !version(value.version)) throw Error('Gravação não confirmada.');
  return value;
}
