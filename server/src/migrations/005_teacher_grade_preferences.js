module.exports = {
  version: 5,
  name: 'teacher_grade_preferences',
  description: 'Cria preferencias versionadas e opcionais de anos escolares para professores.',
  up(db) {
    db.exec(`
      CREATE TABLE teacher_grade_preference_profiles (
        teacher_id INTEGER PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE teacher_grade_preferences (
        teacher_id INTEGER NOT NULL,
        grade_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (teacher_id, grade_id),
        FOREIGN KEY (teacher_id)
          REFERENCES teacher_grade_preference_profiles(teacher_id) ON DELETE CASCADE,
        FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_teacher_grade_preferences_grade
        ON teacher_grade_preferences(grade_id, teacher_id);

      CREATE TRIGGER teacher_grade_profiles_validate_insert
      BEFORE INSERT ON teacher_grade_preference_profiles
      WHEN COALESCE((SELECT role FROM users WHERE id = NEW.teacher_id), '') <> 'professor'
      BEGIN
        SELECT RAISE(ABORT, 'grade_preferences_require_professor');
      END;

      CREATE TRIGGER teacher_grade_profiles_validate_update
      BEFORE UPDATE ON teacher_grade_preference_profiles
      WHEN NEW.teacher_id <> OLD.teacher_id
        OR COALESCE((SELECT role FROM users WHERE id = NEW.teacher_id), '') <> 'professor'
      BEGIN
        SELECT RAISE(ABORT, 'invalid_teacher_grade_preference_update');
      END;

      CREATE TRIGGER users_remove_grade_preferences_after_role_change
      AFTER UPDATE OF role ON users
      WHEN OLD.role = 'professor' AND NEW.role <> 'professor'
      BEGIN
        DELETE FROM teacher_grade_preference_profiles
        WHERE teacher_id = NEW.id;
      END;
    `);
  },
};
