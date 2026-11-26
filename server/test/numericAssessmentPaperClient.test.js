const test=require('node:test'),assert=require('node:assert/strict');
let paper;
test.before(async()=>{paper=await import('../../client/src/services/numericAssessmentPaper.mjs');});
const expected=(audience='student')=>({classId:'class-id',assessmentId:'assessment-id',audience,revision:2,fingerprint:'a'.repeat(64)});
function fixture(audience='student'){
  return {kind:'numeric-assessment-paper-v1',audience,fingerprint:'a'.repeat(64),
    schoolClass:{id:'class-id',name:'6º A'},assessment:{id:'assessment-id',revision:2,title:'Medidas da turma',instructions:'Mostre seus cálculos.',status:'draft',questionCount:2,randomizeQuestions:true},
    items:[1,2].map((number)=>({number,code:'NUM-'+number,skillCode:'EF06MA11',statement:'Calcule a medida.',supportText:'Observe o recipiente.',unit:'litros',
      ...(audience==='teacher'?{answer:number===1?'2,5':'0',explanation:'RESOLUÇÃO RESERVADA'}:{})}))};
}
function previewFixture(){
  const nodes=new Map(),writes=[],listeners=new Set();
  const window={closed:false,opener:{},prints:0,focus(){},print(){this.prints++;},close(){this.closed=true;},
    document:{open(){nodes.clear();},write(html){writes.push(html);},close(){},body:{classList:{toggle(){}}},getElementById(id){if(!nodes.has(id))nodes.set(id,{addEventListener(type,fn){this[type]=fn;},textContent:''});return nodes.get(id);}}};
  return {window,nodes,writes,listeners,origin:{addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)}};
}
test('cópia completa separa atividade, identificação e espaço de resposta do gabarito',()=>{
  const html=paper.numericAssessmentPaperDocument(fixture(),expected());
  for(const part of ['Medidas da turma','6º A','Mostre seus cálculos.','Nome:','Data:','Questão 1','Questão 2','NUM-1','NUM-2','Unidade da resposta: litros'])assert.ok(html.includes(part),part);
  assert.equal((html.match(/class="answer-space"/g)||[]).length,2);assert.doesNotMatch(html,/RESOLUÇÃO RESERVADA|Resposta: 2,5/);
  const teacher=paper.numericAssessmentPaperDocument(fixture('teacher'),expected('teacher'));
  assert.match(teacher,/GABARITO · SOMENTE PARA O PROFESSOR/);assert.match(teacher,/Resposta: 0 \(litros\)/);assert.match(teacher,/Resposta: 2,5/);assert.match(teacher,/RESOLUÇÃO RESERVADA/);
  assert.match(teacher,/Observe o recipiente\./);assert.match(teacher,/2 questões/);
  assert.doesNotMatch(teacher,/class="answer-space"/);
});
test('recusa outra turma, aplicação, revisão, público, ordem, quantidade e gabarito indevido',()=>{
  for(const change of [{classId:'other'},{assessmentId:'other'},{revision:1},{fingerprint:'b'.repeat(64)},{audience:'teacher'}])assert.throws(()=>paper.numericAssessmentPaperDocument(fixture(),{...expected(),...change}));
  for(const alter of [p=>p.items.reverse(),p=>p.items.pop(),p=>p.items[0].answer='2,5',p=>p.items[0].explanation='secret',p=>p.items[0].answerKey={},p=>p.assessment.status='cancelled',p=>p.fingerprint='x',p=>p.assessment.revision=0,p=>p.items[0].statement='']){
    const p=fixture();alter(p);assert.throws(()=>paper.numericAssessmentPaperDocument(p,expected()));
  }
});
test('textos maliciosos ficam literais, sem recursos externos ou scripts executáveis',()=>{
  const p=fixture('teacher'),attack='<script>bad()</script><img src="https://invalid.test">&\'';
  p.assessment.title=attack;p.assessment.instructions=attack;p.schoolClass.name=attack;
  for(const item of p.items)for(const key of ['code','skillCode','statement','supportText','unit','explanation'])item[key]=attack;
  const html=paper.numericAssessmentPaperDocument(p,expected('teacher'));
  assert.doesNotMatch(html,/<(?:script|img|iframe|link|object|embed)\b/i);assert.match(html,/&lt;script&gt;/);assert.match(html,/default-src 'none'/);assert.match(html,/no-referrer/);
});
test('100 questões e textos extensos mantêm conteúdo sem altura fixa ou corte',()=>{
  const p=fixture();p.assessment.questionCount=100;p.items=Array.from({length:100},(_,index)=>({...p.items[0],number:index+1,code:'NUM-'+(index+1)}));
  p.items[0].statement='á'.repeat(10000);p.items[99].supportText='fim'.repeat(3000);
  const html=paper.numericAssessmentPaperDocument(p,expected());assert.match(html,/Questão 100/);assert.ok(html.includes(p.items[0].statement));assert.ok(html.includes(p.items[99].supportText));
  assert.match(html,/size: A4/);assert.match(html,/font-size: 14pt/);assert.doesNotMatch(html,/max-height:|overflow:\s*hidden|position:\s*(fixed|sticky)/);
  p.items.push({...p.items[0],number:101});p.assessment.questionCount=101;assert.throws(()=>paper.numericAssessmentPaperDocument(p,expected()));
});
test('janela começa vazia, só imprime por clique e fecha sem aceitar resposta tardia',()=>{
  const f=previewFixture(),handle=paper.createNumericAssessmentPrintPreview(()=>f.window,f.origin);
  assert.equal(f.window.opener,null);assert.doesNotMatch(f.writes[0],/Medidas da turma|NUM-1/);
  handle.render(fixture(),expected());assert.equal(f.window.prints,0);f.nodes.get('numeric-print-button').click();assert.equal(f.window.prints,1);
  handle.close();assert.equal(f.window.closed,true);assert.equal(f.listeners.size,0);assert.throws(()=>handle.render(fixture('teacher'),expected('teacher')));
});
test('fechamento da origem, popup bloqueado e resposta trocada não deixam gabarito aberto',()=>{
  assert.throws(()=>paper.createNumericAssessmentPrintPreview(()=>null),/numeric_popup_blocked/);
  for(const mode of ['pagehide','wrong-audience','write-error']){
    const f=previewFixture(),handle=paper.createNumericAssessmentPrintPreview(()=>f.window,f.origin);
    if(mode==='pagehide')for(const close of f.listeners)close();
    if(mode==='write-error')f.window.document.write=()=>{throw new Error('write');};
    assert.throws(()=>handle.render(fixture('teacher'),mode==='wrong-audience'?expected():expected('teacher')));
    assert.equal(f.window.closed,true);assert.equal(f.listeners.size,0);assert.equal(f.writes.length,1);
  }
});
