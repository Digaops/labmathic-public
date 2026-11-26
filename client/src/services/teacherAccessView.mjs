import catalog from '../../../shared/teacherAccessCatalog.json' with { type: 'json' };
import pilots from '../../../shared/teacherPilotAccessCatalog.json' with { type: 'json' };

export const accessCatalog = catalog;
export const pilotAccessCatalog = pilots;
export const accessFlagLabels = { ...catalog.flags, ...pilots.flags };
const alwaysOff = ['not_found', 'kill_switch', 'master_disabled', 'release_paused', 'release_retired', 'pilot_group_disabled', 'release_restricted_to_pilot', 'percentage_disabled'];
const alwaysOn = ['homologation_open_testing', 'pilot_group_enabled', 'percentage_enabled'];
const variable = ['user_rule', 'role_rule', 'default'];

export function teacherAccessView(data, id) {
  if (data?.version !== catalog.version || data.user?.id !== id || data.user?.role !== 'professor'
      || !Number.isSafeInteger(id) || id < 1 || !['name', 'email'].every(key => typeof data.user[key] === 'string' && data.user[key].trim())
      || typeof data.checkedAt !== 'string' || !Number.isFinite(Date.parse(data.checkedAt))
      || !Array.isArray(data.features) || data.features.length !== catalog.features.length) throw Error('Consulta de acesso inválida');
  const decisions = new Map();
  const features = parseFeatures(data.features, catalog, decisions);
  let pilotFeatures = null;
  if (data.pilots !== undefined) {
    if (!data.pilots || data.pilots.version !== pilots.version) throw Error('Consulta de pilotos inválida');
    pilotFeatures = parseFeatures(data.pilots.features, pilots, decisions);
  }
  return { checkedAt: data.checkedAt, user: { id, name: data.user.name, email: data.user.email }, features, pilotFeatures };
}

function parseFeatures(items, definitionCatalog, decisions) {
  if (!Array.isArray(items) || items.length !== definitionCatalog.features.length) throw Error('Catálogo incompleto');
  return definitionCatalog.features.map((definition, index) => {
    const feature = items[index];
    if (feature?.id !== definition.id || typeof feature.enabled !== 'boolean'
        || !Array.isArray(feature.checks) || feature.checks.length !== definition.requires.length) throw Error('Recurso inválido');
    const checks = definition.requires.map((key, checkIndex) => {
      const check = feature.checks[checkIndex];
      if (check?.key !== key || typeof check.enabled !== 'boolean'
          || !(variable.includes(check.reason) || (check.enabled ? alwaysOn : alwaysOff).includes(check.reason))) throw Error('Liberação inválida');
      const decision = { key, enabled: check.enabled, reason: check.reason };
      if (decisions.has(key) && decisions.get(key) !== JSON.stringify(decision)) throw Error('Liberações divergentes');
      decisions.set(key, JSON.stringify(decision));
      return decision;
    });
    if (feature.enabled !== checks.every(check => check.enabled)) throw Error('Dependências divergentes');
    return { ...definition, enabled: feature.enabled, checks };
  });
}

export function accessReason(check) {
  const messages = {
    not_found: 'A configuração deste recurso ainda não está instalada.',
    kill_switch: 'O recurso foi interrompido por segurança. Precisa de revisão técnica.',
    master_disabled: 'O recurso está desligado na configuração geral.',
    release_paused: 'A versão deste recurso está pausada.',
    release_retired: 'A versão deste recurso foi retirada de uso.',
    homologation_open_testing: 'Liberado para testes gerais na homologação.',
    user_rule: check.enabled ? 'Liberado especificamente para esta conta.' : 'Bloqueado especificamente para esta conta.',
    pilot_group_disabled: 'Um grupo de testes desta conta bloqueia o recurso.',
    pilot_group_enabled: 'Liberado por um grupo de testes desta conta.',
    role_rule: check.enabled ? 'Liberado para o perfil de professor.' : 'Não liberado para o perfil de professor.',
    release_restricted_to_pilot: 'Disponível apenas para participantes do teste; esta conta não foi incluída.',
    percentage_enabled: 'Esta conta está incluída na liberação gradual.',
    percentage_disabled: 'Esta conta ainda não está incluída na liberação gradual.',
    default: check.enabled ? 'Liberado pela configuração padrão.' : 'Não liberado pela configuração padrão.',
  };
  return messages[check.reason] || 'Não foi possível explicar esta liberação. Consulte novamente.';
}
