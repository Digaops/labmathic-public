export const userRoles = { professor: 'Professor(a)', admin: 'Administrador(a)' };
export function userItem(data) {
  if (!data || !Number.isSafeInteger(data.id) || data.id < 1 || typeof data.name !== 'string' || !data.name.trim()
    || typeof data.email !== 'string' || !data.email.trim() || !Object.hasOwn(userRoles, data.role) || !/^[a-f0-9]{64}$/.test(data.version)) throw Error('Conta inválida');
  return { id: data.id, name: data.name, email: data.email, role: data.role, created_at: data.created_at, version: data.version };
}
export function userList(data) {
  if (!Array.isArray(data)) throw Error('Lista inválida');
  const items = data.map(userItem);
  if (new Set(items.map(i => i.id)).size !== items.length) throw Error('Contas repetidas');
  return items;
}
export function userDetail(data, id) {
  const item = userItem(data);
  if (item.id !== id || !(data.deletion_block === null || typeof data.deletion_block === 'string')) throw Error('Conta diferente');
  if (!(data.role_change_block == null || typeof data.role_change_block === 'string')) throw Error('Perfil inválido');
  return { ...item, deletion_block: data.deletion_block, role_change_block: data.role_change_block || null };
}
const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
export const filterUsers = (items, search, role) => items.filter(i => (!role || i.role === role) && normalize(i.name + ' ' + i.email).includes(normalize(search)));
export const userDraft = item => ({ name: item?.name || '', email: item?.email || '', role: item?.role || 'professor', password: '' });
export function userIssue(form, mode) {
  if (mode !== 'reset') {
    if (!form.name.trim() || form.name.trim().length > 100) return ['name', 'Informe um nome com até 100 caracteres.'];
    if (form.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return ['email', 'Informe um e-mail válido.'];
    if (!Object.hasOwn(userRoles, form.role)) return ['role', 'Escolha um perfil de acesso.'];
  }
  if (['create', 'reset'].includes(mode) && (form.password.length < 8 || form.password.length > 1024)) return ['password', 'Use uma senha de 8 a 1024 caracteres.'];
  return null;
}
export function userPayload(form, mode, item) {
  if (mode === 'reset') return { password: form.password, expectedVersion: item.version };
  if (mode === 'delete') return { expectedVersion: item.version };
  const value = { name: form.name.trim(), email: form.email.trim().toLowerCase(), role: form.role };
  return mode === 'create' ? { ...value, password: form.password } : { ...value, expectedVersion: item.version };
}
