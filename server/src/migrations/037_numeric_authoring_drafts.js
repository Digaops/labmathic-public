module.exports = {
  version: 37,
  name: 'numeric_authoring_drafts',
  description: 'Isola rascunhos numéricos privados do banco de alternativas e da aplicação aos estudantes.',
  up(db) {
    db.exec(`
      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES('question_bank.numeric_drafts','Rascunhos de resposta numérica',
          'Autoria privada com resposta exata. Não libera aplicação, revisão editorial ou publicação.',0,0,0);
      CREATE TRIGGER numeric_draft_question_insert_guard BEFORE INSERT ON questions
        WHEN NEW.question_type = 'numeric_draft'
          AND (NEW.status <> 'inactive' OR NEW.source <> 'teacher' OR NEW.created_by IS NULL)
      BEGIN SELECT RAISE(ABORT, 'numeric_question_must_remain_private_draft'); END;
      CREATE TRIGGER numeric_draft_question_update_guard BEFORE UPDATE ON questions
        WHEN (OLD.question_type = 'numeric_draft' OR NEW.question_type = 'numeric_draft')
          AND (NEW.question_type IS NOT OLD.question_type OR NEW.status <> 'inactive'
            OR NEW.source IS NOT OLD.source OR NEW.created_by IS NOT OLD.created_by
            OR NEW.skill_id IS NOT OLD.skill_id OR NEW.question_code IS NOT OLD.question_code)
      BEGIN SELECT RAISE(ABORT, 'numeric_question_must_remain_private_draft'); END;
      CREATE TRIGGER numeric_draft_no_options BEFORE INSERT ON question_options
        WHEN EXISTS(SELECT 1 FROM questions WHERE id = NEW.question_id AND question_type = 'numeric_draft')
      BEGIN SELECT RAISE(ABORT, 'numeric_draft_has_no_options'); END;
      CREATE TRIGGER numeric_draft_no_options_update BEFORE UPDATE OF question_id ON question_options
        WHEN EXISTS(SELECT 1 FROM questions WHERE id = NEW.question_id AND question_type = 'numeric_draft')
      BEGIN SELECT RAISE(ABORT, 'numeric_draft_has_no_options'); END;
      CREATE TRIGGER numeric_draft_not_in_sets BEFORE INSERT ON question_set_items
        WHEN EXISTS(SELECT 1 FROM questions WHERE id = NEW.question_id AND question_type = 'numeric_draft')
      BEGIN SELECT RAISE(ABORT, 'numeric_draft_not_ready_for_application'); END;
      CREATE TRIGGER numeric_draft_not_in_sets_update BEFORE UPDATE OF question_id ON question_set_items
        WHEN EXISTS(SELECT 1 FROM questions WHERE id = NEW.question_id AND question_type = 'numeric_draft')
      BEGIN SELECT RAISE(ABORT, 'numeric_draft_not_ready_for_application'); END;
      CREATE TRIGGER numeric_draft_version_insert_guard BEFORE INSERT ON typed_question_item_versions
        WHEN EXISTS(SELECT 1 FROM typed_question_items i JOIN questions q ON q.id = i.question_id
          WHERE i.id = NEW.item_id AND q.question_type = 'numeric_draft')
          AND (NEW.version <> 1 OR NEW.status <> 'draft' OR NEW.interaction_type <> 'numeric'
            OR NEW.scoring_strategy <> 'numeric_exact')
      BEGIN SELECT RAISE(ABORT, 'numeric_draft_not_ready_for_publication'); END;
      CREATE TRIGGER numeric_draft_version_update_guard BEFORE UPDATE ON typed_question_item_versions
        WHEN EXISTS(SELECT 1 FROM typed_question_items i JOIN questions q ON q.id = i.question_id
          WHERE i.id = NEW.item_id AND q.question_type = 'numeric_draft')
          AND (NEW.status <> 'draft' OR NEW.interaction_type <> 'numeric' OR NEW.scoring_strategy <> 'numeric_exact')
      BEGIN SELECT RAISE(ABORT, 'numeric_draft_not_ready_for_publication'); END;
      CREATE TRIGGER numeric_draft_no_review BEFORE INSERT ON typed_question_review_cycles
        WHEN EXISTS(SELECT 1 FROM typed_question_items i JOIN questions q ON q.id = i.question_id
          WHERE i.id = NEW.item_id AND q.question_type = 'numeric_draft')
      BEGIN SELECT RAISE(ABORT, 'numeric_draft_not_ready_for_review'); END;
    `);
  },
};
