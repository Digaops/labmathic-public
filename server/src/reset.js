const db = require('./database');

console.log('🧹 Limpando dados de exemplo...');

db.prepare('DELETE FROM activity_log').run();
db.prepare('DELETE FROM notifications').run();
db.prepare('DELETE FROM support_messages').run();
db.prepare('DELETE FROM support_threads').run();
db.prepare("DELETE FROM questions WHERE source = 'teacher'").run();
db.prepare('DELETE FROM comments').run();
db.prepare('DELETE FROM ratings').run();
db.prepare('DELETE FROM share_links').run();
db.prepare('DELETE FROM collection_items').run();
db.prepare('DELETE FROM collections').run();
db.prepare('DELETE FROM favorites').run();
db.prepare('DELETE FROM access_history').run();
db.prepare('DELETE FROM material_topics').run();
db.prepare('DELETE FROM materials').run();
db.prepare('DELETE FROM password_reset_tokens').run();
db.prepare("DELETE FROM users WHERE role != 'admin'").run();

// Reset auto-increment sequences
db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('materials','material_topics','access_history','favorites','collections','collection_items','ratings','comments','share_links','notifications','activity_log','password_reset_tokens','support_threads','support_messages')").run();

console.log('✅ Banco limpo!');
console.log('   Mantidos: disciplinas, séries, tópicos, tipos de material e usuário admin');
console.log('   Credencial do administrador preservada. Não use credenciais de demonstração em produção.');
