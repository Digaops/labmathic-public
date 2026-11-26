const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const header = fs.readFileSync(
  path.resolve(__dirname, '../../client/src/components/Header.jsx'),
  'utf8'
);

test('menu principal acompanha a jornada do professor sem links longos soltos', () => {
  assert.match(header, /Navegação principal/);
  assert.match(header, />\s*Avaliações\s*</);
  assert.match(header, />\s*Recursos\s*</);
  assert.match(header, /to="\/turmas"/);
  assert.match(header, /to="\/recomposicao"/);
  assert.match(header, /to="\/planejamento"/);
  assert.match(header, /planning\.lesson_planner/);
  assert.match(header, /desktop-assessments-menu/);
  assert.match(header, /desktop-resources-menu/);
  assert.match(header, /As aplicações e os resultados ficam dentro de cada turma/);
});

test('grupos preservam todos os destinos atuais e indicam a rota ativa', () => {
  for (const route of [
    '/banco-questoes',
    '/simulados',
    '/colecoes',
    '/biblioteca',
    '/favoritos',
  ]) {
    assert.match(header, new RegExp(`to="${route}"`));
  }
  assert.match(header, /assessmentsActive/);
  assert.match(header, /resourcesActive/);
  assert.match(header, /aria-controls="desktop-assessments-menu"/);
  assert.match(header, /role="region"/);
  assert.match(header, /event\.key === 'Escape'/);
});

test('menu compacto é responsivo, organizado por seções e mantém o suporte visível', () => {
  assert.match(header, /id="mobile-main-menu"/);
  assert.match(header, /max-h-\[calc\(100dvh-4rem\)\]/);
  assert.match(header, /menuOpen \? 'Fechar menu' : 'Abrir menu'/);
  assert.match(header, />Principal</);
  assert.match(header, />Avaliações</);
  assert.match(header, />Recursos</);
  assert.match(header, />Ajuda</);
  assert.match(header, /Fale Conosco/);
  assert.match(header, /supportUnreadCount > 0/);
  assert.match(header, /bg-orange-400/);
});

test('identificação evita repetir o papel quando o nome cadastrado é genérico', () => {
  assert.match(header, /userName\.toLocaleLowerCase\('pt-BR'\) !== roleLabel\.toLocaleLowerCase\('pt-BR'\)/);
  assert.match(header, /user\?\.email\?\.split\('@'\)\[0\]/);
  assert.match(header, /compactUserName/);
});
