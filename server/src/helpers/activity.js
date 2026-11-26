const db = require('../database');

const SENSITIVE_KEYS = new Set([
  'password',
  'senha',
  'token',
  'jwt',
  'authorization',
  'resetToken',
  'reset_token',
  'fileBase64',
  'base64',
]);

const MODULE_LABELS = {
  auth: 'Autenticação',
  materials: 'Materiais',
  collections: 'Laboratórios',
  question_bank: 'Banco de Questões',
  question_sets: 'Simulados',
  users: 'Usuários',
  admin: 'Administração',
  favorites: 'Favoritos',
  comments: 'Comentários',
  ratings: 'Avaliações',
  governance: 'Governança de releases',
  classes: 'Turmas e estudantes',
  preferences: 'Preferências pedagógicas',
  planning: 'Planejamento de aulas',
};

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object') return value ?? null;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item));
  }

  return Object.entries(value).reduce((acc, [key, entry]) => {
    if (SENSITIVE_KEYS.has(key)) return acc;
    acc[key] = typeof entry === 'object' && entry !== null ? sanitizeMetadata(entry) : entry;
    return acc;
  }, {});
}

function normalizeUser(userOrId, database = db) {
  if (!userOrId) return {};

  if (typeof userOrId === 'object') {
    return {
      id: userOrId.id || null,
      name: userOrId.name || userOrId.email || null,
      role: userOrId.role || null,
    };
  }

  try {
    const user = database.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userOrId);
    return {
      id: user?.id || userOrId,
      name: user?.name || user?.email || null,
      role: user?.role || null,
    };
  } catch {
    return { id: userOrId };
  }
}

function inferModule(action, entityType) {
  if (action?.includes('login') || action?.includes('password')) return 'auth';
  if (entityType === 'material') return 'materials';
  if (entityType === 'collection') return 'collections';
  if (entityType === 'question') return 'question_bank';
  if (entityType === 'question_set') return 'question_sets';
  if (entityType === 'user') return 'users';
  if (action === 'favorite' || action === 'unfavorite') return 'favorites';
  return 'admin';
}

function buildLegacyPayload(userId, action, entityType = null, entityId = null, metadata = null) {
  return {
    user: userId,
    action,
    module: inferModule(action, entityType),
    entityType,
    entityId,
    entityTitle: metadata?.title || metadata?.name || null,
    description: null,
    metadata,
    isCritical: action?.includes('delete') || action?.includes('reset'),
  };
}

function writeActivity(payload, database = db) {
  const user = normalizeUser(payload.user, database);
  const metadata = sanitizeMetadata(payload.metadata);
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  const moduleName = payload.module || inferModule(payload.action, payload.entityType);
  const entityTitle = payload.entityTitle || metadata?.title || metadata?.name || null;
  const description = payload.description || buildDescription({
    userName: user.name,
    action: payload.action,
    module: moduleName,
    entityType: payload.entityType,
    entityTitle,
  });

  return database.prepare(`
    INSERT INTO activity_log (
      user_id,
      user_name,
      user_role,
      action,
      module,
      entity_type,
      entity_id,
      entity_title,
      description,
      metadata,
      metadata_json,
      ip_address,
      user_agent,
      is_critical
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.id || null,
    user.name || null,
    user.role || null,
    payload.action,
    moduleName,
    payload.entityType || null,
    payload.entityId || null,
    entityTitle,
    description,
    metadataJson,
    metadataJson,
    payload.req?.ip || payload.ipAddress || null,
    payload.req?.get?.('user-agent') || payload.userAgent || null,
    payload.isCritical ? 1 : 0
  );
}

function logActivity(...args) {
  const payload = typeof args[0] === 'object' && args.length === 1
    ? args[0]
    : buildLegacyPayload(...args);

  try {
    return writeActivity(payload);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Erro ao registrar atividade:', err.message);
    }
  }
  return null;
}

function logActivityStrict(payload, database = db) {
  return writeActivity(payload, database);
}

function buildDescription({ userName, action, module, entityType, entityTitle }) {
  const actor = userName || 'Usuário';
  const target = entityTitle ? ` "${entityTitle}"` : '';
  const readableAction = actionLabels[action] || action?.replace(/_/g, ' ') || 'registrou uma ação';
  const moduleLabel = MODULE_LABELS[module] || module || entityType || 'sistema';
  return `${actor} ${readableAction}${target} em ${moduleLabel}.`;
}

const actionLabels = {
  login: 'realizou login',
  login_failed: 'tentou fazer login sem sucesso',
  password_reset_requested: 'solicitou redefinição de senha',
  password_reset_completed: 'redefiniu a senha',
  update_grade_preferences: 'atualizou os anos escolares de interesse',
  save_assessment_responses: 'salvou respostas para correção',
  submit_assessment_results: 'concluiu uma correção objetiva',
  revise_assessment_results: 'iniciou a revisão de uma correção objetiva',
  enable_student_assessment_access: 'habilitou a resposta on-line dos estudantes',
  disable_student_assessment_access: 'desabilitou a resposta on-line dos estudantes',
  generate_student_assessment_credentials: 'gerou acessos individuais para uma avaliação',
  revoke_student_assessment_credential: 'revogou um acesso individual de avaliação',
  submit_student_online_assessment: 'teve uma avaliação enviada on-line por um estudante',
  auto_submit_student_online_assessment: 'teve uma avaliação enviada automaticamente ao fim do prazo',
  create_diagnostic_question_set: 'gerou uma avaliação diagnóstica',
  review_diagnostic_question_set: 'confirmou a revisão pedagógica da avaliação diagnóstica',
  create_learning_recovery_plan: 'confirmou um plano de recomposição',
  update_learning_recovery_plan: 'salvou a revisão do plano de recomposição',
  activate_learning_recovery_plan: 'concluiu e ativou o plano de recomposição',
  start_learning_recovery_execution: 'organizou a execução do plano de recomposição',
  update_learning_recovery_execution: 'atualizou uma etapa do plano de recomposição',
  update_learning_recovery_resources: 'revisou os recursos de uma intervenção',
  create_learning_recovery_monitoring: 'preparou a verificação do plano de recomposição',
  complete_learning_recovery_execution: 'concluiu o ciclo de recomposição',
  create_teaching_plan: 'criou um planejamento de aulas',
  update_teaching_plan: 'atualizou um planejamento de aulas',
  activate_teaching_plan: 'iniciou um planejamento de aulas',
  update_teaching_plan_lesson: 'registrou a execução de uma aula',
  complete_teaching_plan: 'concluiu um planejamento de aulas',
  archive_teaching_plan: 'arquivou um planejamento de aulas',
  duplicate_teaching_plan: 'reutilizou um planejamento de aulas',
  create_material: 'criou o material',
  update_material: 'editou o material',
  delete_material: 'excluiu o material',
  bulk_delete_materials: 'excluiu materiais em massa',
  favorite: 'favoritou o material',
  unfavorite: 'removeu o material dos favoritos',
  create_collection: 'criou o laboratório',
  update_collection: 'editou o laboratório',
  delete_collection: 'excluiu o laboratório',
  add_collection_item: 'vinculou material ao laboratório',
  remove_collection_item: 'removeu material do laboratório',
  create_question: 'criou a questão',
  update_question: 'editou a questão',
  update_question_status: 'alterou o status da questão',
  update_question_review: 'alterou a revisão da questão',
  delete_question: 'desativou a questão',
  create_question_set: 'criou o simulado',
  update_question_set: 'editou o simulado',
  delete_question_set: 'excluiu o simulado',
  create_user: 'criou o usuário',
  update_user: 'editou o usuário',
  reset_user_password: 'redefiniu a senha de um usuário',
  delete_user: 'excluiu o usuário',
  create_release: 'criou a release',
  update_release: 'editou a release',
  update_release_status: 'alterou o estágio da release',
  create_feature_flag: 'criou a feature flag',
  update_feature_flag: 'alterou a feature flag',
  activate_kill_switch: 'acionou o kill switch',
  deactivate_kill_switch: 'desativou o kill switch',
  create_pilot_group: 'criou o grupo-piloto',
  update_pilot_group: 'alterou o grupo-piloto',
  add_pilot_group_member: 'adicionou membro ao grupo-piloto',
  remove_pilot_group_member: 'removeu membro do grupo-piloto',
  upsert_feature_flag_group_rule: 'alterou a regra de grupo da feature flag',
  upsert_feature_flag_user_rule: 'alterou a regra de usuário da feature flag',
  remove_feature_flag_group_rule: 'removeu a regra de grupo da feature flag',
  remove_feature_flag_user_rule: 'removeu a regra de usuário da feature flag',
  create_class: 'criou a turma',
  update_class: 'editou a turma',
  archive_class: 'arquivou a turma',
  restore_class: 'restaurou a turma',
  create_student: 'cadastrou um estudante',
  update_student: 'editou um estudante',
  enroll_student: 'matriculou um estudante',
  withdraw_student: 'retirou um estudante da turma',
  import_students: 'importou estudantes para a turma',
  create_class_entry_code: 'criou um código de entrada',
  revoke_class_entry_code: 'revogou um código de entrada',
  create_class_assessment: 'criou uma aplicação de simulado',
  update_class_assessment: 'editou uma aplicação de simulado',
  exempt_class_assessment_participant: 'dispensou um estudante da avaliação, preservando o histórico',
  schedule_class_assessment: 'agendou uma aplicação de simulado',
  open_class_assessment: 'disponibilizou uma aplicação de simulado',
  return_class_assessment_to_draft: 'retirou o agendamento da aplicação de simulado',
  close_class_assessment: 'encerrou uma aplicação de simulado',
  cancel_class_assessment: 'cancelou uma aplicação de simulado',
  auto_open_class_assessment: 'teve uma aplicação de simulado aberta automaticamente',
  auto_close_class_assessment: 'teve uma aplicação de simulado encerrada automaticamente',
};

module.exports = {
  logActivity,
  logActivityStrict,
  sanitizeMetadata,
  MODULE_LABELS,
};
