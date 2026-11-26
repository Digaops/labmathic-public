const { isDeepStrictEqual } = require('node:util');
const { configuration, FLAG } = require('./aiConfig');
const { AiError, fail } = require('./aiErrors');
const { prepare, requestBody, readSkill, validateOutput } = require('./aiQuestionContract');
const { createUsageService, parseUsage } = require('./aiUsageService');
const { createOpenaiService, extractSuggestion, hasExpectedPricing } = require('./openaiService');
const { evaluateFeatureFlag } = require('./featureFlags');
function authorize(db, actor) {
  const user = db.prepare('SELECT id,role,auth_version FROM users WHERE id=?').get(actor?.id ?? -1);
  if (!user || !['professor','admin'].includes(user.role) || user.auth_version !== actor.auth_version) fail('AI_FORBIDDEN');
  return user;
}
function checkFlag(db, user) {
  if (!evaluateFeatureFlag(db, FLAG, user).enabled) fail('AI_DISABLED');
}
function createAiQuestions(db, { config = configuration, provider = createOpenaiService(), now = Date.now } = {}) {
  const usageService = createUsageService(db, { now });
  return {
    async generate(actor, input, key, verifySession = () => {}) {
      const user = authorize(db, actor), settings = config();
      if (!settings.configured) fail('AI_NOT_CONFIGURED');
      checkFlag(db, user);
      const brief = prepare(db, input, settings);
      requestBody(brief, settings); // Bound full request size before reserving or contacting the provider.
      const id = usageService.reserve(user, brief.quantity, settings, key);
      let usage = null, result, failure, uncertainPricing = false;
      try {
        const response = await provider.generate(brief, settings);
        usage = parseUsage(response?.usage);
        uncertainPricing = !hasExpectedPricing(response);
        if (!usage) fail('AI_USAGE_UNAVAILABLE');
        result = validateOutput(extractSuggestion(response), brief);
        try {
          if (!isDeepStrictEqual(brief.skill, readSkill(db, brief.skill.id))) fail('AI_CURRICULUM_CHANGED');
        } catch { fail('AI_CURRICULUM_CHANGED'); }
        verifySession();
        checkFlag(db, authorize(db, actor));
      } catch (error) {
        failure = error instanceof AiError ? error : new AiError('AI_PROVIDER_UNAVAILABLE');
      }
      // Record actual usage even when the output is refused, invalid, or the session was revoked.
      usageService.settle(id, usage, !failure, failure?.code, settings, { uncertainPricing });
      if (failure) throw failure;
      return { ...result, request_id: id, requires_teacher_review: true, saved: false };
    },
  };
}
module.exports = { createAiQuestions };
