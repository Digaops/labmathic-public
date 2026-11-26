// Only code-owned SQL aliases are accepted. Legacy mappings retain their behavior;
// a managed mapping whose source changed can never silently become curated again.
function eligibleMaterialSkill(alias = 'mapping') {
  if (!/^[a-z_]+$/.test(alias)) throw Error('Invalid mapping alias.');
  return `NOT EXISTS (SELECT 1 FROM material_bncc_review_state review_state
    WHERE review_state.material_id=${alias}.material_id AND review_state.skill_id=${alias}.skill_id
      AND (review_state.needs_review=1 OR review_state.review_id IS NULL))`;
}
module.exports = { eligibleMaterialSkill };
