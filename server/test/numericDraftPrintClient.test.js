const test = require('node:test');
const assert = require('node:assert/strict');
let printing, view;
test.before(async () => {
  printing = await import('../../client/src/services/numericDraftPrint.mjs');
  view = await import('../../client/src/services/numericDraftView.mjs');
});
const id = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
function fixture() {
  return {kind:'numeric-draft-preview-v1',fingerprint:'a'.repeat(64),draft:{publicId:id,revision:2,status:'draft',code:'NUM-TEST',statement:'Qual é a metade de 5 litros?',supportText:'A jarra tem 5 litros.',answer:'2,5',unit:'litros',explanation:'Divida 5 por 2.',strategy:'numeric_exact',difficulty:'media',curriculum:{gradeId:1,gradeName:'6º Ano',unitId:2,unitName:'Números',skillId:3,skillCode:'EF06MA11',skillDescription:'Resolver problemas com números decimais.'}}};
}
function fakePreview() {
  const nodes = new Map(), writes = [], listeners = new Set(), toggles = [];
  const doc = {open(){nodes.clear();},write(html){writes.push(html);},close(){},body:{classList:{toggle:(...args)=>toggles.push(args)}},
    getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}});return nodes.get(id);}};
  const window = {document:doc,opener:{},closed:false,printCalls:0,focus(){},print(){this.printCalls++;},close(){this.closed=true;}};
  const origin = {addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
  return {window,origin,nodes,writes,listeners,toggles};
}
test('cópia identifica rascunho e gabarito, preserva BNCC, texto, resposta e orientações',()=>{
  const html = printing.getNumericDraftPrintDocument(fixture(),id,2);
  for(const content of ['RASCUNHO - CONFERÊNCIA DO PROFESSOR','Não aplicar à turma','não representa aprovação editorial','Gabarito - somente para o professor','6º Ano','EF06MA11','A jarra tem 5 litros.','Qual é a metade de 5 litros?','2,5 (litros)','Divida 5 por 2.','NUM-TEST · Revisão 2',...view.numericReviewQuestions]) assert.ok(html.includes(content),content);
  assert.match(html,/@page \{ size: A4; margin: 16mm/);assert.match(html,/font-size: 14pt/);
  assert.doesNotMatch(html,/position:\s*(fixed|sticky)|overflow:\s*hidden|max-height:/);
});
test('prévia recusa outro ID, revisão, formato ou fingerprint antes da renderização',()=>{
  for(const [value,expectedId,rev] of [[fixture(),'other',2],[fixture(),id,1],[{...fixture(),kind:'approved'},id,2],[{...fixture(),fingerprint:'x'},id,2],[{...fixture(),draft:{...fixture().draft,answer:undefined}},id,2]]) assert.throws(()=>printing.getNumericDraftPrintDocument(value,expectedId,rev));
});
test('todos os textos são escapados; HTML não executa scripts nem busca recursos externos',()=>{
  const value=fixture(),attack='<script>bad()</script><img src="https://invalid.test" onerror="bad()">&\'';
  for(const key of ['statement','supportText','unit','explanation','code'])value.draft[key]=attack;
  for(const key of ['gradeName','unitName','skillDescription','skillCode'])value.draft.curriculum[key]=attack;
  const html=printing.getNumericDraftPrintDocument(value,id,2);
  assert.doesNotMatch(html,/<(?:script|img|iframe|a|link|object|embed)\b/i);
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));assert.ok(html.includes('&amp;&#39;'));
  assert.match(html,/default-src 'none'/);assert.match(html,/form-action 'none'/);assert.match(html,/no-referrer/);
});
test('texto longo não é cortado e ausência de resolução/unidade é explícita',()=>{
  const value=fixture();value.draft.statement='á'.repeat(10000);value.draft.supportText='b'.repeat(10000);value.draft.explanation='c'.repeat(5000);
  let html=printing.getNumericDraftPrintDocument(value,id,2);
  for(const key of ['statement','supportText','explanation'])assert.ok(html.includes(value.draft[key]));
  value.draft.explanation='';value.draft.unit='';value.draft.answer='0';
  html=printing.getNumericDraftPrintDocument(value,id,2);assert.match(html,/Resposta esperada: 0</);assert.match(html,/Resolução ainda não registrada/);assert.doesNotMatch(html,/Unidade da resposta:/);
});
test('janela começa sem conteúdo; impressão depende de clique, sem opener e com fonte maior',()=>{
  const f=fakePreview(),handle=printing.createNumericDraftPrintPreview(()=>f.window,f.origin);
  assert.equal(f.window.opener,null);assert.doesNotMatch(f.writes[0],/jarra|2,5|NUM-TEST/);assert.match(f.writes[0],/numeric-print-button" disabled/);
  handle.render(fixture(),id,2);assert.equal(f.window.printCalls,0);
  f.nodes.get('numeric-print-large').handlers.change({target:{checked:true}});assert.deepEqual(f.toggles,[['large-text',true]]);
  const print=f.nodes.get('numeric-print-button').handlers.click;print();assert.equal(f.window.printCalls,1);
  f.nodes.get('numeric-print-close').handlers.click();print();assert.equal(f.window.printCalls,1);assert.equal(f.listeners.size,0);
});
test('popup bloqueado, fechamento, pagehide e falha de renderização nunca entregam conteúdo tardio',()=>{
  assert.throws(()=>printing.createNumericDraftPrintPreview(()=>null),/numeric_popup_blocked/);
  for(const mode of ['close','pagehide','bad-context','write-failure']){
    const f=fakePreview(),handle=printing.createNumericDraftPrintPreview(()=>f.window,f.origin);
    if(mode==='close')handle.close();
    if(mode==='pagehide')for(const close of f.listeners)close();
    if(mode==='write-failure')f.window.document.write=()=>{throw new Error('write-failure');};
    assert.throws(()=>handle.render(fixture(),mode==='bad-context'?'wrong':id,2));
    assert.equal(f.window.closed,true);assert.equal(f.listeners.size,0);assert.equal(f.window.printCalls,0);assert.equal(f.writes.length,1);
  }
});
test('falha na criação limpa janela; falha de impressão oferece comando manual',()=>{
  let f=fakePreview();f.window.document.write=()=>{throw new Error('broken');};
  assert.throws(()=>printing.createNumericDraftPrintPreview(()=>f.window,f.origin));assert.equal(f.window.closed,true);assert.equal(f.listeners.size,0);
  f=fakePreview();const handle=printing.createNumericDraftPrintPreview(()=>f.window,f.origin);handle.render(fixture(),id,2);
  f.window.print=()=>{throw new Error('blocked');};f.nodes.get('numeric-print-button').handlers.click();assert.match(f.nodes.get('numeric-print-status').textContent,/comando Imprimir do navegador/);handle.close();
});
