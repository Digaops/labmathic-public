const test = require('node:test');
const assert = require('node:assert/strict');

test('modal inclui summary no ciclo, não pula o gabarito e rola para o foco de teclado', async () => {
  const previous = Object.fromEntries(['document','window','getComputedStyle'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const handlers=new Map();let selector='';
  function element(tagName, options={}) {
    return {tagName,isConnected:true,tabIndex:0,style:{zIndex:''},parentElement:null,
      getClientRects:()=>options.hidden?[]:[{}],closest:()=>null,matches:()=>Boolean(options.disabled),
      focus(settings){this.lastFocus=settings;document.activeElement=this;},setAttribute(){},getAttribute:()=>null,removeAttribute(){},...options};
  }
  const opener=element('BUTTON'),close=element('BUTTON'),copy=element('BUTTON'),summary=element('SUMMARY');
  const details=element('DETAILS',{open:false,children:[],contains:()=>false});
  summary.parentElement=details;summary.contains=e=>e===summary;
  const concealed=element('SUMMARY',{parentElement:details});
  details.children=[summary,concealed];
  const disabled=element('BUTTON',{disabled:true}),hidden=element('SUMMARY',{hidden:true});
  const dialog=element('SECTION',{querySelectorAll(value){selector=value;return value.includes('summary')?[close,copy,summary,concealed,disabled,hidden]:[close,copy,disabled];},contains:e=>[dialog,close,copy,summary,concealed,disabled,hidden].includes(e)});
  Object.assign(globalThis,{document:{activeElement:opener,body:{style:{overflow:'auto',paddingRight:''}},documentElement:{clientWidth:1024},addEventListener:(key,fn)=>handlers.set(key,fn),removeEventListener:key=>handlers.delete(key)},window:{innerWidth:1024},getComputedStyle:()=>({visibility:'visible',paddingRight:'0'})});
  let release;
  try {
    const {registerModal}=await import('../../client/src/services/modalLifecycle.mjs');
    release=registerModal(dialog,()=>{});
    const key=(shiftKey=false)=>{const e={key:'Tab',shiftKey,prevented:false,preventDefault(){this.prevented=true;}};handlers.get('keydown')(e);return e;};
    document.activeElement=close;assert.equal(key(true).prevented,true);
    assert.match(selector,/summary/);assert.equal(document.activeElement,summary);assert.deepEqual(summary.lastFocus,{preventScroll:false});
    document.activeElement=copy;assert.equal(key().prevented,false,'o navegador pode avançar do botão para o summary');
    document.activeElement=summary;assert.equal(key().prevented,true);assert.equal(document.activeElement,close);assert.deepEqual(close.lastFocus,{preventScroll:false});
    details.open=true;
    document.activeElement=close;key(true);assert.equal(document.activeElement,concealed,'conteúdo aberto participa do ciclo');
    document.activeElement=concealed;key();assert.equal(document.activeElement,close);
    details.open=false;
    document.activeElement=close;key(true);assert.equal(document.activeElement,summary,'conteúdo recolhido com retângulo de layout não captura foco');
    const outer=element('DETAILS',{open:false,children:[]}),outerSummary=element('SUMMARY',{contains:e=>e===outerSummary});
    outer.children=[outerSummary,details];details.parentElement=outer;
    document.activeElement=close;key(true);assert.equal(document.activeElement,copy,'um ancestral recolhido também esconde o summary interno');
    outer.open=true;
    document.activeElement=close;key(true);assert.equal(document.activeElement,summary);
    release();assert.equal(document.activeElement,opener);assert.deepEqual(opener.lastFocus,{preventScroll:true});assert.equal(handlers.size,0);assert.equal(document.body.style.overflow,'auto');
  } finally {
    release?.();
    for(const [key,descriptor]of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
});
