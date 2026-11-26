const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let view;
test.before(async()=>{view=await import('../../client/src/services/numericDraftView.mjs');});
const saved = () => ({publicId:'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',revision:1,status:'draft',code:'NUM-TEST',statement:'Qual é a metade de 5?',
  difficulty:'media',curriculum:{gradeId:1,gradeName:'6º Ano',unitId:2,unitName:'Números',skillId:3,skillCode:'EF06MA11',skillDescription:'Decimais'},
  answer:'2,5',unit:'litros',supportText:'',explanation:'Divida por dois.',strategy:'numeric_exact'});
test('contrato da tela aceita rascunho completo e reconstitui envio sem perder zero',()=>{
  assert.equal(view.parseNumericDetail(saved()).answer,'2,5');
  const form=view.numericForm({...saved(),answer:'0'});
  assert.equal(view.numericPayload(form,saved()).answer,'0');
  assert.equal(view.numericPayload(form,saved()).expectedRevision,1);
  assert.equal(view.numericPayload(form,saved()).skillId,3);
});
test('contrato recusa dados incompletos, outro formato, contagens e IDs incoerentes',()=>{
  for(const patch of [{answer:undefined},{strategy:'numeric_range'},{revision:0},{publicId:'1'},{status:'published'},{curriculum:null},{statement:''}]) assert.throws(()=>view.parseNumericDetail({...saved(),...patch}));
  const summary=saved(); delete summary.answer;
  assert.throws(()=>view.parseNumericDetail(summary));
  assert.equal(view.parseNumericPage({data:[summary],pagination:{page:1,total:1,totalPages:1}}).data.length,1);
  assert.throws(()=>view.parseNumericPage({data:[summary,summary],pagination:{page:1,total:2,totalPages:1}}));
  assert.throws(()=>view.parseNumericPage({data:[],pagination:{page:1,total:11,totalPages:1}}));
});
test('validação decimal do editor acompanha os limites do servidor sem inicializar banco',()=>{
  const {numericValue}=require('../src/services/numericQuestionDrafts');
  for(const value of ['0','-0','2,5','2.500','+2',',5','-0.000001','999999999.999999','',null,'1e3','1/2','1.234,56','1000000000','0.1234567']) {
    let accepted=true; try{numericValue(value);}catch{accepted=false;}
    assert.equal(view.validDecimal(value),accepted,String(value));
  }
  assert.equal(Object.keys(require.cache).some(key=>/[\\/]src[\\/]database\.js$/.test(key)),false);
});
test('formulário impede salvar sem classificação e preserva classificação da versão salva',()=>{
  assert.throws(()=>view.numericPayload(view.emptyNumericDraft()));
  assert.throws(()=>view.numericPayload({...view.numericForm(saved()),skillId:''}));
  assert.deepEqual(view.numericForm(saved()).gradeId,'1');
});
test('estados editoriais bloqueiam edição e contratos preservam histórico e versão aprovada',()=>{
  const review={publicId:'cccccccc-1111-2222-3333-bbbbbbbbbbbb',revision:1,status:'pending',reason:null};
  assert.equal(view.canEditNumeric({...saved(),review}),false);
  assert.equal(view.canEditNumeric({...saved(),status:'approved'}),false);
  assert.equal(view.canEditNumeric({...saved(),review:{...review,status:'rejected'}}),true);
  const approved={...saved(),status:'approved',version:1,review:{...review,status:'approved'}};
  assert.equal(view.parseNumericDetail(approved).status,'approved');
  assert.equal(view.parseNumericReview({...review,authorName:'Pessoa sintética',versionPublicId:saved().publicId,draft:saved()}).status,'pending');
  assert.throws(()=>view.parseNumericReview({...review,authorName:'Pessoa',versionPublicId:review.publicId,draft:saved()}));
  assert.throws(()=>view.parseNumericReviewPage({data:[review],pagination:{page:1,total:1,totalPages:1}}));
});
test('revisão numérica tem acesso explícito na administração, flag e recuperação idempotente',()=>{
  const read=p=>fs.readFileSync(require.resolve('../../client/src/'+p),'utf8');
  assert.match(read('App.jsx'),/flag="question_bank.numeric_drafts"><NumericReviews/);
  assert.match(read('pages/admin/AdminDashboard.jsx'),/\/admin\/questoes-numericas\/revisoes/);
  assert.match(read('components/AdministrativeHome.jsx'),/\/admin\/questoes-numericas\/revisoes/);
  const admin=read('pages/admin/NumericReviews.jsx');
  assert.match(admin,/user\?\.role === 'admin'/);assert.match(admin,/'Idempotency-Key':pending.current.key/);
  assert.match(admin,/disabled=\{busy\|\|uncertain\|\|conflict\}/);assert.match(admin,/useAccountLeave/);
});
test('integração sob flag, carregamento sob demanda, proteção de saída e envio estável',()=>{
  const manager=fs.readFileSync(require.resolve('../../client/src/components/TeacherQuestionManager.jsx'),'utf8');
  const screen=fs.readFileSync(require.resolve('../../client/src/components/NumericQuestionDrafts.jsx'),'utf8');
  assert.match(manager,/lazy\(\(\) => import\('\.\/NumericQuestionDrafts'\)\)/);
  assert.match(manager,/isEnabled\('question_bank.numeric_drafts'\)/);
  assert.match(screen,/beforeunload/); assert.match(screen,/'Idempotency-Key': operation.key/);
  assert.match(screen,/disabled=\{busy \|\| uncertain \|\| conflict \|\| readOnly\}/);
});
