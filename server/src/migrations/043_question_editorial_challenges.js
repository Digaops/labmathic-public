const { installQuestionEditorialChallenges } = require('../services/installQuestionEditorialPilot');

module.exports = {
  version: 43,
  name: 'question_editorial_challenges',
  description: 'Prepara desafios de Matemática do 1º ao 9º ano para revisão pedagógica.',
  up(db) {
    installQuestionEditorialChallenges(db, {
      'grades1-3.json': '2ec7b42f41bf5f1e91e0767d4f143de2b7c1cd38c1f13b9496920d4f325bc3a3',
      'grades4-6.json': '4f559a2cc3520ca4414c229b10b9903a1f9d042674f4a03a26fe6632fd452ce3',
      'grades7-9.json': 'f9c029e7279278f8b9c987106951b3434d2e6c5d9a13e9a0853c43e519478bd6',
    });
  },
};
