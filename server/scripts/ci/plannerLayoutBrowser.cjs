const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const root=fs.realpathSync(path.resolve(__dirname,'../../..'));
const {chromium,expect}=createRequire(path.join(root,'client/package.json'))('@playwright/test');
async function runPlannerLayoutBrowser({baseUrl,teacher,admin,tokenFor,classPublicId,plan,materialId,skill,db,output}){
  assert.equal(process.env.PLANNER_LAYOUT_BROWSER,'1');assert.match(baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name,/labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output,path.join(root,'tmp/planner-layout-qa'));
  const token=tokenFor(teacher);let operation=0;
  const literalPattern=value=>new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  async function api(url,method='GET',body){
    const response=await fetch(baseUrl+'/api'+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'planner-fixture-'+(++operation)},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();assert.ok(response.ok,url+': '+JSON.stringify(data));return data;
  }
  const bootstrap=await api('/lesson-plans/bootstrap'),schoolClass=bootstrap.classes.find(c=>c.publicId===classPublicId),disciplineId=schoolClass.disciplines[0].id;
  const skillCode=db.prepare('SELECT code FROM bncc_skills WHERE id=?').pluck().get(skill);assert.ok(skillCode);
  const target=(await api('/classes','POST',{name:'Turma de destino QA',gradeId:schoolClass.gradeId,academicYear:schoolClass.academicYear,disciplineIds:[disciplineId]}));
  const targetId=target.id||target.publicId||target.class?.id||target.class?.publicId;
  assert.ok(targetId,'Target class id: '+JSON.stringify(target));
  db.prepare('INSERT OR IGNORE INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES (?,?,?)').run(materialId,skill,admin.id);
  const q=Number(db.prepare("INSERT INTO questions(question_code,skill_id,statement,difficulty,status,reviewed,source,created_by) VALUES ('PLANNER-QA-001',?,'Como explicar a estratégia usada para resolver o problema?','media','active',1,'official',?)").run(skill,admin.id).lastInsertRowid);
  for(let i=0;i<4;i++)db.prepare('INSERT INTO question_options(question_id,option_label,option_text,is_correct,sort_order) VALUES (?,?,?,?,?)').run(q,'ABCD'[i],'Alternativa '+(i+1),Number(i===0),i+1);
  const setId=Number(db.prepare("INSERT INTO question_sets(user_id,title,is_public) VALUES (?,'Simulado de planejamento QA',0)").run(teacher.id).lastInsertRowid);
  db.prepare('INSERT INTO question_set_items(question_set_id,question_id,sort_order) VALUES (?,?,1)').run(setId,q);
  // Persist more than the former 30-result window; no mock-only pagination proof.
  const catalogue={materials:[],questions:[],questionSets:[]};
  db.transaction(()=>{
    for(let i=0;i<35;i++){
      const suffix=String(i).padStart(3,'0');
      const title=i===0?'Órbita distante material QA':'Material paginado QA '+suffix;
      const id=Number(db.prepare("INSERT INTO materials(title,description,grade_id,discipline_id,file_format,created_by,updated_at) VALUES (?, 'Catálogo sintético de planejamento', ?, ?, 'PDF', ?, '2026-09-14 12:00:00')").run(title,schoolClass.gradeId,disciplineId,admin.id).lastInsertRowid);
      db.prepare('INSERT INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES (?,?,?)').run(id,skill,admin.id);
      catalogue.materials.push({id,title});
      const code='PLANNER-QA-PAGED-'+suffix,statement=i===34?'Órbita distante questão QA':'Questão paginada QA '+suffix;
      const questionId=Number(db.prepare("INSERT INTO questions(question_code,skill_id,statement,difficulty,status,reviewed,source,created_by) VALUES (?,?,?,'media','active',1,'official',?)").run(code,skill,statement,admin.id).lastInsertRowid);
      for(let j=0;j<4;j++)db.prepare('INSERT INTO question_options(question_id,option_label,option_text,is_correct,sort_order) VALUES (?,?,?,?,?)').run(questionId,'ABCD'[j],'Opção sintética '+(j+1),Number(j===0),j+1);
      catalogue.questions.push({id:questionId,title:statement,code});
      const setTitle=i===0?'Órbita distante simulado QA':'Simulado paginado QA '+suffix;
      const questionSetId=Number(db.prepare("INSERT INTO question_sets(user_id,title,is_public,updated_at) VALUES (?, ?, 0, '2026-09-14 12:00:00')").run(teacher.id,setTitle).lastInsertRowid);
      db.prepare('INSERT INTO question_set_items(question_set_id,question_id,sort_order) VALUES (?,?,1)').run(questionSetId,questionId);
      catalogue.questionSets.push({id:questionSetId,title:setTitle});
    }
  })();
  const baseBody={title:'Planejamento de teste',classPublicId,disciplineId,periodType:'week',startsOn:'2026-09-14',endsOn:'2026-09-18',lessons:[1,2].map(i=>({title:'Aula '+i,objective:'Comparar e explicar estratégias de resolução.',plannedDate:'2026-09-14',durationMinutes:50,teacherNotes:'Anotação original '+i,skillIds:[skill],resources:[{type:'material',id:materialId},{type:'activity',title:'Conversa em grupos',notes:'Organizar duplas.'}]}))};
  let working=(await api('/lesson-plans','POST',baseBody)).plan;
  const functionalOnly=process.env.PLANNER_FUNCTIONAL_ONLY==='1';
  const report={status:'running',syntheticDataOnly:true,functionalOnly,inventory:[],cases:[],internal:[],pageErrors:[]};
  const record=()=>fs.writeFileSync(path.join(output,functionalOnly?'report-functional.json':'report.json'),JSON.stringify(report,null,2));
  const check=description=>{report.inventory.push({description});record();console.log('Planejamento:',description);};record();
  if(process.env.PLANNER_LAYOUT_INTERACTIVE==='1'){
    db.prepare('INSERT INTO question_set_items(question_set_id,question_id,sort_order) VALUES (?,?,2)').run(setId,catalogue.questions[0].id);
    const file=path.join(output,'interactive-connection.json'),stop=path.join(output,'interactive-stop');
    if(fs.existsSync(stop))fs.unlinkSync(stop);
    fs.writeFileSync(file,JSON.stringify({baseUrl,teacher,token,planId:working.publicId,classPublicId,targetId,skill,gradeId:schoolClass.gradeId,disciplineId,materialId,questionId:q,questionSetId:setId}));
    console.log('PLANNER_LAYOUT_INTERACTIVE_READY');
    try{await new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(fs.existsSync(stop)){clearInterval(timer);clearTimeout(expiry);resolve();}},250);const expiry=setTimeout(()=>{clearInterval(timer);reject(Error('Interactive expired'));},480000);});}
    finally{if(fs.existsSync(file))fs.unlinkSync(file);if(fs.existsSync(stop))fs.unlinkSync(stop);}
    return {...report,status:'captured'};
  }
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})}),contexts=[];
  async function context(width=1024,height=600,theme='dark',user=teacher){
    const c=await browser.newContext({viewport:{width,height},colorScheme:theme,...(width<600?{isMobile:true,hasTouch:true}:{})});contexts.push(c);c.setDefaultTimeout(6000);
    await c.route('**/*',r=>r.request().url().startsWith(baseUrl+'/')?r.continue():r.abort());
    await c.addInitScript(({baseUrl,user,token,theme})=>{if(location.origin===baseUrl){localStorage.setItem('theme',theme);if(!sessionStorage.getItem('planner_qa_seeded')){sessionStorage.setItem('labmathic_auth_session_v1',JSON.stringify({user,token}));sessionStorage.setItem('planner_qa_seeded','1');}}},{baseUrl,user,token:tokenFor(user),theme});
    c.on('page',p=>p.on('pageerror',e=>report.pageErrors.push(e.message)));return c;
  }
  async function go(p,url='/planejamento'){await p.goto(baseUrl+url);await p.waitForLoadState('networkidle');const notice=p.getByRole('button',{name:'Entendi, continuar'});if(await notice.isVisible()){await notice.click();await p.waitForLoadState('networkidle');}}
  const editor=p=>p.locator('[data-planner-editor]'),stage=p=>editor(p).getByLabel('Aula do planejamento',{exact:true}),dialog=p=>p.getByRole('dialog');
  const leaveDialog=p=>p.getByRole('dialog',{name:'Sair sem salvar?',exact:true});
  const pendingDialog=p=>p.getByRole('dialog',{name:'Aguarde a confirmação do envio',exact:true});
  async function stay(p){await expect(leaveDialog(p)).toBeVisible();await leaveDialog(p).getByRole('button',{name:'Ficar nesta tela',exact:true}).click();await expect(leaveDialog(p)).toHaveCount(0);}
  async function discard(p){await expect(leaveDialog(p)).toBeVisible();await leaveDialog(p).getByRole('button',{name:'Sair sem salvar',exact:true}).click();await expect(leaveDialog(p)).toHaveCount(0);}
  async function searchResources(p,value){await dialog(p).getByLabel('Buscar no acervo',{exact:true}).fill(value);await dialog(p).getByRole('button',{name:'Buscar',exact:true}).click();}
  function gate(){let release,started;return {wait:new Promise(resolve=>{release=resolve;}),ready:new Promise(resolve=>{started=resolve;}),release:()=>release(),started:()=>started()};}
  async function open(p){await go(p,'/planejamento/'+working.publicId);await expect(stage(p)).toBeVisible();}
  async function capture(p,name){
    // Functional reruns do not overwrite screenshots or count as a visual pass.
    if(functionalOnly)return;
    await p.screenshot({path:path.join(output,name+'.png'),scale:'css'});
    const m=await p.evaluate(()=>{
      const d=document.querySelector('[role=dialog]'),scope=d||document.querySelector('[data-planner-editor]')||document.querySelector('[data-lesson-plans]');
      const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,right:b.right,bottom:b.bottom};};
      return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dialog:d?{...box(d),scroll:d.scrollWidth,client:d.clientWidth}:null,
        controls:[...scope.querySelectorAll('button,a,summary,input,select,textarea')].filter(e=>e.getClientRects().length&&!e.closest('details:not([open]) :not(summary)')).map(e=>({label:e.getAttribute('aria-label')||e.textContent.slice(0,50),...box(e.matches('input[type=checkbox]')?e.closest('label'):e)}))};
    });
    report.cases.push({name,...m});record();assert.ok(m.scrollWidth<=m.width+1,name+': page overflow');
    if(m.dialog){assert.ok(m.dialog.scroll<=m.dialog.client+1,name+': dialog overflow');assert.ok(m.dialog.y>=0&&m.dialog.bottom<=m.height+1,name+': dialog bounds');}
    for(const control of m.controls){assert.ok(control.w>=43.5&&control.h>=43.5,name+': target '+control.label);assert.ok(control.x>=0&&control.right<=m.width+1,name+': bounds '+control.label);}
  }
  const latest=async()=> (await api('/lesson-plans/'+working.publicId)).plan;
  try{
    report.resourceFailures=await require('./plannerResourceBrowser.cjs').runPlannerResourceBrowser({
      browser,baseUrl,teacher,token,planId:working.publicId,
      materialTitle:db.prepare('SELECT title FROM materials WHERE id=?').pluck().get(materialId),
    });
    check('Falhas dos chunks de consulta e PDF ficam no modal; editor, escolhas, proteção de saída e salvamento preservados; fixture original restaurada');
    check('Conta e planos artificiais, catálogo e duas turmas no banco temporário; nenhuma chamada externa');
    if(!functionalOnly)for(const [w,h] of [[1024,600],[390,664],[320,600]])for(const theme of ['dark','light']){
      const c=await context(w,h,theme),p=await c.newPage();await go(p);await capture(p,'list-'+w+'-'+theme);
      await p.getByRole('link',{name:'Criar planejamento',exact:true}).click();await expect(editor(p).getByLabel('Título do planejamento')).toBeVisible();await capture(p,'new-'+w+'-'+theme);
      await open(p);await capture(p,'draft-'+w+'-'+theme);
      await editor(p).getByRole('button',{name:'Escolher habilidades bncc',exact:true}).click();await expect(dialog(p).getByRole('checkbox').first()).toBeVisible();await capture(p,'skills-'+w+'-'+theme);await p.keyboard.press('Escape');
      await editor(p).getByRole('button',{name:'Escolher recursos da aula',exact:true}).click();await expect(dialog(p).getByRole('checkbox').first()).toBeVisible();await capture(p,'resources-'+w+'-'+theme);
      await dialog(p).getByRole('button',{name:'Próxima página',exact:true}).click();await expect(dialog(p).getByText(/Página 2 de/)).toBeVisible();await capture(p,'resources-page-2-'+w+'-'+theme);
      await dialog(p).getByLabel('Tipo de recurso').selectOption('activity');await capture(p,'activity-'+w+'-'+theme);await p.keyboard.press('Escape');
      await editor(p).getByLabel('Observações do professor').fill('Texto preservado ao ficar nesta tela.');await editor(p).getByRole('button',{name:'Voltar aos planejamentos',exact:true}).click();await expect(leaveDialog(p)).toBeVisible();await capture(p,'navigation-guard-'+w+'-'+theme);await stay(p);await expect(editor(p).getByLabel('Observações do professor')).toHaveValue('Texto preservado ao ficar nesta tela.');await c.close();
    }
    const c=await context(),p=await c.newPage();await go(p);
    await p.getByLabel('Buscar planejamento').fill('nada assim');await p.getByRole('button',{name:'Buscar',exact:true}).click();await expect(p.getByRole('heading',{name:'Nenhum planejamento neste filtro'})).toBeVisible();
    await capture(p,'empty-filter');await p.getByRole('button',{name:'Limpar filtros'}).click();
    await p.route('**/api/lesson-plans?*',r=>r.fulfill({status:200,json:{}}));await p.getByRole('button',{name:'Buscar',exact:true}).click();await p.reload();
    await expect(p.getByRole('alert')).toBeVisible();await expect(p.getByRole('heading',{name:'Você ainda não criou um planejamento'})).toHaveCount(0);await capture(p,'list-invalid');await p.unroute('**/api/lesson-plans?*');await p.getByRole('button',{name:'Tentar novamente'}).click();await expect(p.locator('[data-planner-row]').first()).toBeVisible();
    await p.getByText('Situação: Todas',{exact:true}).click();await p.getByLabel('Filtrar por situação').selectOption('active');await expect(p.getByRole('heading',{name:'Nenhum planejamento nesta situação'})).toBeVisible();assert.match(p.url(),/situacao=active/);await p.getByRole('button',{name:'Limpar filtros'}).click();
    // Invalid initial reads must not release a blank editor over an existing plan.
    await p.route('**/api/lesson-plans/'+working.publicId,r=>r.fulfill({status:200,json:{}}));await go(p,'/planejamento/'+working.publicId);await expect(p.getByRole('alert')).toBeVisible();await expect(p.getByRole('button',{name:'Salvar rascunho',exact:true})).toHaveCount(0);await p.unroute('**/api/lesson-plans/'+working.publicId);await p.getByRole('button',{name:'Tentar novamente'}).click();await expect(stage(p)).toBeVisible();
    check('Busca e situação preservadas; erros de lista e de abertura não simulam ausência nem liberam edição vazia');

    // Both native history directions and a normal application link must preserve
    // the draft on cancel, and allow deliberate discard without a second prompt.
    await go(p);await p.locator('[data-planner-row="'+working.publicId+'"]').getByRole('link').click();await expect(stage(p)).toBeVisible();
    const note=editor(p).getByLabel('Observações do professor');
    async function libraryLink(){const link=p.locator('a[href="/biblioteca"]:visible').first();if(!await link.count()){const compact=p.getByRole('button',{name:'Abrir menu',exact:true});if(await compact.isVisible())await compact.click();else await p.getByRole('button',{name:'Recursos',exact:true}).click();}await link.click();}
    await note.fill('Rascunho preservado no histórico.');await p.goBack();await stay(p);await expect(note).toHaveValue('Rascunho preservado no histórico.');
    await p.goBack();await discard(p);await expect(p.locator('[data-lesson-plans]')).toBeVisible();await p.goForward();await expect(stage(p)).toBeVisible();
    await libraryLink();await expect(p).toHaveURL(baseUrl+'/biblioteca');await p.goBack();await expect(stage(p)).toBeVisible();
    await note.fill('Rascunho preservado ao avançar.');await p.goForward();await stay(p);await expect(note).toHaveValue('Rascunho preservado ao avançar.');
    await p.goForward();await discard(p);await expect(p).toHaveURL(baseUrl+'/biblioteca');await p.goBack();await expect(stage(p)).toBeVisible();
    await note.fill('Rascunho preservado no link.');await libraryLink();await stay(p);await expect(note).toHaveValue('Rascunho preservado no link.');
    for(let attempt=0;attempt<2;attempt++){
      const before=p.url();
      // Schedule the native reload after the evaluation returns. A cancelled
      // beforeunload intentionally never commits or emits a new load event.
      const [warning]=await Promise.all([
        p.waitForEvent('dialog'),
        p.evaluate(()=>{setTimeout(()=>window.location.reload(),0);}),
      ]);
      assert.equal(warning.type(),'beforeunload');await warning.dismiss();
      await expect(p).toHaveURL(before);await expect(note).toHaveValue('Rascunho preservado no link.');
    }
    await libraryLink();await discard(p);await expect(p).toHaveURL(baseUrl+'/biblioteca');await open(p);
    check('Voltar/avançar reais, link Biblioteca e duas recargas canceladas: ficar preserva texto e listener beforeunload; sair descarta e alcança exatamente o destino');

    // The target in each persisted catalogue is outside the old first 30 rows.
    const targets=[['materials',catalogue.materials[0]],['questions',catalogue.questions[34]],['questionSets',catalogue.questionSets[0]]];
    await editor(p).getByRole('button',{name:'Escolher recursos da aula',exact:true}).click();
    for(const [category,targetResource] of targets){
      const params=new URLSearchParams({category,skillIds:String(skill),gradeId:String(schoolClass.gradeId),disciplineId:String(disciplineId),page:'1'});
      const all=[];let batch=await api('/lesson-plans/catalog/resources?'+params);all.push(...batch.items);
      for(let page=2;page<=batch.totalPages;page++){params.set('page',String(page));batch=await api('/lesson-plans/catalog/resources?'+params);all.push(...batch.items);}
      assert.ok(all.findIndex(item=>item.id===targetResource.id)>=30,category+': target really exceeds the old 30-result window');
      await dialog(p).getByLabel('Tipo de recurso').selectOption(category);await expect(dialog(p).getByText(/Página 1 de/)).toBeVisible();
      const selectable=all.find(item=>item.id!==materialId),choice=dialog(p).getByRole('checkbox',{name:literalPattern(selectable.code||selectable.title)});
      await choice.check();await dialog(p).getByRole('button',{name:'Próxima página',exact:true}).click();await expect(dialog(p).getByText(/Página 2 de/)).toBeVisible();
      await dialog(p).getByRole('button',{name:'Página anterior',exact:true}).click();await expect(choice).toBeChecked();
      await searchResources(p,'orbita distante');await expect(dialog(p).getByText(/1 recurso encontrado/)).toBeVisible();await dialog(p).getByRole('checkbox',{name:literalPattern(targetResource.title)}).check();
    }
    await dialog(p).getByLabel('Tipo de recurso').selectOption('materials');await searchResources(p,'orbita distante');await expect(dialog(p).getByRole('checkbox',{name:/Órbita distante material QA/})).toBeChecked();
    await capture(p,'catalogue-beyond-thirty');
    await searchResources(p,'não existe no catálogo QA');await expect(dialog(p).getByText(/0 recursos encontrados/)).toBeVisible();await expect(dialog(p).getByText(/Tente outra palavra ou limpe a busca/)).toBeVisible();await capture(p,'catalogue-zero');
    await dialog(p).getByRole('button',{name:'Limpar busca',exact:true}).click();await expect(dialog(p).getByText(/Página 1 de/)).toBeVisible();
    const resourcesUrl='**/api/lesson-plans/catalog/resources?*';
    await p.route(resourcesUrl,r=>r.fulfill({status:503,json:{error:'Falha sintética recuperável do catálogo'}}));await searchResources(p,'recuperável');await expect(dialog(p).getByRole('alert')).toContainText('Falha sintética');await capture(p,'catalogue-error');
    await p.unroute(resourcesUrl);await dialog(p).getByRole('button',{name:'Tentar novamente'}).click();await expect(dialog(p).getByText(/0 recursos encontrados/)).toBeVisible();
    const stale=gate();
    await p.route(resourcesUrl,async r=>{const old=new URL(r.request().url()).searchParams.get('search')==='antiga';if(old){stale.started();await stale.wait;}await r.fulfill({status:200,json:{items:[{id:catalogue.materials[0].id,title:old?'Resposta antiga do catálogo':'Resposta atual do catálogo',skillMatch:1}],total:1,page:1,pageSize:20,totalPages:1,category:'materials'}}).catch(()=>{});});
    try{await searchResources(p,'antiga');await stale.ready;await searchResources(p,'atual');await expect(dialog(p).getByRole('checkbox',{name:/Resposta atual do catálogo/})).toBeVisible();stale.release();await p.waitForLoadState('networkidle');await expect(dialog(p).getByRole('checkbox',{name:/Resposta antiga do catálogo/})).toHaveCount(0);}
    finally{stale.release();await p.unroute(resourcesUrl);}
    await dialog(p).getByRole('button',{name:'Cancelar',exact:true}).click();await expect(leaveDialog(p)).toBeVisible();await p.keyboard.press('Escape');await expect(leaveDialog(p)).toHaveCount(0);await expect(dialog(p).getByRole('button',{name:'Cancelar',exact:true})).toBeFocused();await expect(dialog(p).getByLabel('Buscar no acervo')).toHaveValue('atual');
    await dialog(p).getByRole('button',{name:'Cancelar',exact:true}).click();await discard(p);await expect(dialog(p)).toHaveCount(0);
    check('35 materiais, 35 questões e 35 simulados persistidos: busca sem acento encontra item além dos 30; seleção permanece entre páginas/tipos; vazio, falha/retry e resposta antiga não substituem a busca atual');

    // Create from the UI; all choices below use the real temporary catalogue.
    await go(p,'/planejamento/novo');await editor(p).getByLabel('Título do planejamento').fill('Criação com resposta perdida');await editor(p).getByLabel('Turma',{exact:true}).selectOption(classPublicId);await editor(p).getByLabel('Início',{exact:true}).fill('2026-09-14');await editor(p).getByLabel('Término').fill('2026-09-18');
    await editor(p).getByRole('button',{name:'Continuar para as aulas'}).click();await editor(p).getByRole('button',{name:'Salvar rascunho',exact:true}).click();await expect(editor(p).getByRole('alert')).toContainText('título e objetivo');
    await editor(p).getByLabel('Título da aula').fill('Planejar uma conversa matemática');await editor(p).getByLabel('Objetivo de aprendizagem').fill('Comparar estratégias em duplas.');await editor(p).getByLabel('Duração (minutos)').fill('');
    await editor(p).getByRole('button',{name:'Adicionar aula',exact:true}).click();await editor(p).getByLabel('Título da aula').fill('Aula que não será mantida');p.once('dialog',d=>d.dismiss());await editor(p).getByRole('button',{name:'Remover aula',exact:true}).click();await expect(editor(p).getByLabel('Título da aula')).toHaveValue('Aula que não será mantida');p.once('dialog',d=>d.accept());await editor(p).getByRole('button',{name:'Remover aula',exact:true}).click();await expect(stage(p).locator('option')).toHaveCount(1);
    const skillsUrl='**/api/lesson-plans/catalog/skills?*';await p.route(skillsUrl,r=>r.fulfill({status:503,json:{error:'Catálogo temporariamente indisponível'}}));await editor(p).getByRole('button',{name:'Escolher habilidades bncc',exact:true}).click();await expect(dialog(p).getByRole('alert')).toBeVisible();await p.unroute(skillsUrl);await dialog(p).getByRole('button',{name:'Tentar novamente'}).click();await dialog(p).getByRole('checkbox',{name:literalPattern(skillCode)}).check();
    const otherGrade=bootstrap.grades.find(g=>g.id!==schoolClass.gradeId);assert.ok(otherGrade);await dialog(p).getByLabel('Ano da habilidade').selectOption(String(otherGrade.id));await dialog(p).getByText('Selecionadas · 1/10',{exact:true}).click();await expect(dialog(p).getByRole('button',{name:'Remover '+skillCode,exact:true})).toBeVisible();
    await p.keyboard.press('Escape');await stay(p);await expect(dialog(p)).toBeVisible();await dialog(p).getByRole('button',{name:'Confirmar habilidades'}).click();
    await p.route(resourcesUrl,r=>r.fulfill({status:200,json:{materials:null}}));await editor(p).getByRole('button',{name:'Escolher recursos da aula',exact:true}).click();await expect(dialog(p).getByRole('alert')).toBeVisible();await p.unroute(resourcesUrl);await dialog(p).getByRole('button',{name:'Tentar novamente'}).click();await dialog(p).getByRole('checkbox').first().check();
    await dialog(p).getByLabel('Tipo de recurso').selectOption('questions');await searchResources(p,'PLANNER-QA-001');await dialog(p).getByRole('checkbox',{name:/PLANNER-QA-001/}).check();await dialog(p).getByLabel('Tipo de recurso').selectOption('questionSets');await searchResources(p,'Simulado de planejamento QA');await dialog(p).getByRole('checkbox',{name:/Simulado de planejamento QA/}).check();await searchResources(p,'Nenhum título assim');await expect(dialog(p).getByText(/Tente outra palavra ou limpe a busca/)).toBeVisible();
    await dialog(p).getByLabel('Tipo de recurso').selectOption('activity');await dialog(p).getByLabel('Atividade',{exact:true}).fill('Discussão em duplas');await dialog(p).getByLabel('Orientações').fill('Registrar estratégias no quadro.');await expect(dialog(p).getByRole('button',{name:'Confirmar recursos'})).toBeDisabled();await dialog(p).getByRole('button',{name:'Adicionar atividade',exact:true}).click();await dialog(p).getByRole('button',{name:'Confirmar recursos'}).click();await expect(editor(p).getByRole('heading',{name:'Recursos da aula · 4',exact:true})).toBeVisible();
    let createPosts=0;const createUrl=baseUrl+'/api/lesson-plans',createPending=gate();
    await p.route(createUrl,async r=>{createPosts++;await r.fetch();createPending.started();await createPending.wait;await r.fulfill({status:503,json:{error:'Resposta perdida após criar'}});});
    try{await editor(p).getByRole('button',{name:'Salvar rascunho',exact:true}).click();await createPending.ready;await libraryLink();await expect(pendingDialog(p)).toBeVisible();await expect(pendingDialog(p).getByRole('button',{name:'Sair sem salvar',exact:true})).toHaveCount(0);await capture(p,'create-pending-navigation');await pendingDialog(p).getByRole('button',{name:'Ficar nesta tela',exact:true}).click();assert.match(p.url(),/\/planejamento\/novo$/);}
    finally{createPending.release();}
    await expect(editor(p).getByRole('button',{name:'Conferir envio'})).toBeVisible();await expect(editor(p).getByLabel('Título da aula')).toBeDisabled();await capture(p,'create-uncertain');assert.equal(createPosts,1);
    await p.unroute(createUrl);await p.route(createUrl,r=>r.fulfill({status:400,json:{error:'Catálogo mudou durante a conferência'}}));await editor(p).getByRole('button',{name:'Conferir envio'}).click();await expect(editor(p).getByRole('alert')).toContainText('Catálogo mudou');await expect(editor(p).getByLabel('Título da aula')).toBeDisabled();await p.unroute(createUrl);await editor(p).getByRole('button',{name:'Conferir envio'}).click();await expect(editor(p).getByRole('heading',{name:'Editar planejamento'})).toBeVisible();
    assert.equal(db.prepare("SELECT COUNT(*) FROM teaching_plans WHERE title='Criação com resposta perdida'").pluck().get(),1);const createdId=p.url().split('/').at(-1).split('?')[0],created=(await api('/lesson-plans/'+createdId)).plan;assert.equal(created.lessons[0].resources.length,4);assert.equal(created.lessons[0].durationMinutes,null);
    p.once('dialog',d=>d.dismiss());await editor(p).getByRole('button',{name:'Arquivar rascunho'}).click();await expect(editor(p).getByRole('heading',{name:'Editar planejamento'})).toBeVisible();p.once('dialog',d=>d.accept());await editor(p).getByRole('button',{name:'Arquivar rascunho'}).click();await expect(editor(p).getByText('Arquivado',{exact:true})).toBeVisible();await expect(editor(p).getByRole('textbox')).toHaveCount(0);
    check('Criação pela interface com quatro tipos de recursos, seleção fora do filtro, erros recuperáveis, cancelamento e arquivamento; resposta perdida produz um único rascunho');
    await open(p);await editor(p).getByLabel('Observações do professor').fill('Minha edição da segunda aula');await stage(p).selectOption('1');await editor(p).getByLabel('Observações do professor').fill('Segunda anotação pendente');await stage(p).selectOption('0');await expect(editor(p).getByLabel('Observações do professor')).toHaveValue('Minha edição da segunda aula');
    await editor(p).getByRole('button',{name:'Voltar aos planejamentos'}).click();await stay(p);await expect(stage(p)).toBeVisible();
    await editor(p).getByRole('button',{name:'Salvar rascunho',exact:true}).click();await expect(editor(p).getByRole('status')).toContainText('Rascunho salvo');
    await editor(p).getByRole('checkbox',{name:'Revisei objetivos, habilidades, recursos e datas'}).check();await editor(p).getByLabel('Título da aula').fill('Aula revisada');await expect(editor(p).getByRole('checkbox')).not.toBeChecked();await expect(editor(p).getByRole('button',{name:'Revisar e iniciar'})).toBeDisabled();
    await editor(p).getByRole('button',{name:'Salvar rascunho',exact:true}).click();await expect(editor(p).getByRole('status')).toBeVisible();
    // An independent saved revision must not erase the local draft.
    await editor(p).getByLabel('Objetivo de aprendizagem').fill('Objetivo local que precisa ser preservado.');
    const remote=await latest();await api('/lesson-plans/'+working.publicId,'PUT',{...baseBody,title:'Alteração em outro acesso',expectedRevision:remote.revision});
    await editor(p).getByRole('button',{name:'Salvar rascunho',exact:true}).click();await expect(editor(p).getByRole('alert')).toBeVisible();await expect(editor(p).getByLabel('Objetivo de aprendizagem')).toHaveValue('Objetivo local que precisa ser preservado.');
    await editor(p).getByText('Copiar minha edição',{exact:true}).click();await expect(editor(p).getByLabel('Texto da minha edição')).toHaveValue(/Objetivo local que precisa ser preservado/);await editor(p).getByLabel('Texto da minha edição').focus();assert.ok(await editor(p).getByLabel('Texto da minha edição').evaluate(e=>e.readOnly&&e.selectionEnd>e.selectionStart&&!e.disabled));await editor(p).getByText('Copiar minha edição',{exact:true}).click();
    await editor(p).getByRole('alert').getByRole('button',{name:'Conferir versão salva'}).click();await expect(editor(p).getByRole('heading',{name:'Versão salva no servidor'})).toBeVisible();await capture(p,'conflict');
    p.once('dialog',d=>d.accept());await editor(p).getByRole('button',{name:'Conferi; manter minha edição'}).click();
    await editor(p).getByRole('button',{name:'Salvar rascunho',exact:true}).click();await expect(editor(p).getByRole('status')).toBeVisible();
    await editor(p).getByRole('checkbox',{name:'Revisei objetivos, habilidades, recursos e datas'}).check();await editor(p).getByRole('button',{name:'Revisar e iniciar'}).click();await expect(editor(p).getByRole('heading',{name:'Acompanhar aulas'})).toBeVisible();
    await stage(p).selectOption('1');await editor(p).getByLabel('Registro da aula').fill('Anotação da segunda aula ainda não enviada');await stage(p).selectOption('0');
    await editor(p).getByLabel('Registro da aula').fill('A primeira aula foi realizada.');await editor(p).getByRole('button',{name:'Marcar como realizada'}).click();await expect(editor(p).getByRole('button',{name:'Salvar registro'})).toBeVisible();
    await stage(p).selectOption('1');await expect(editor(p).getByLabel('Registro da aula')).toHaveValue('Anotação da segunda aula ainda não enviada');await editor(p).getByLabel('Registro da aula').fill('curto');await editor(p).getByRole('button',{name:'Não realizada',exact:true}).click();await expect(editor(p).getByRole('alert')).toContainText('10 caracteres');
    await editor(p).getByLabel('Registro da aula').fill('A turma participou de outra atividade escolar.');await editor(p).getByRole('button',{name:'Não realizada',exact:true}).click();await expect(editor(p).getByRole('button',{name:'Concluir ciclo'})).toBeEnabled();
    if(!functionalOnly)for(const [w,h] of [[1024,600],[390,664],[320,600]])for(const theme of ['dark','light']){
      const cc=await context(w,h,theme),pp=await cc.newPage();await open(pp);await capture(pp,'tracking-'+w+'-'+theme);await editor(pp).getByText('Objetivo, habilidades e recursos',{exact:true}).click();await capture(pp,'history-details-'+w+'-'+theme);await cc.close();
    }
    p.once('dialog',d=>d.dismiss());await editor(p).getByRole('button',{name:'Concluir ciclo'}).click();assert.equal((await latest()).status,'active');
    p.once('dialog',d=>d.accept());await editor(p).getByRole('button',{name:'Concluir ciclo'}).click();await expect(editor(p).getByText('Concluído',{exact:true})).toBeVisible();await capture(p,'completed');
    // Establish a same-document Router history entry before testing Back while
    // duplicating. open()/page.goto creates a document entry, whose protection
    // correctly belongs to native beforeunload rather than the SPA blocker.
    await editor(p).getByRole('button',{name:'Voltar aos planejamentos',exact:true}).click();
    await expect(p).toHaveURL(baseUrl+'/planejamento');
    await p.locator('[data-planner-row="'+working.publicId+'"]').getByRole('link',{name:'Consultar histórico',exact:true}).click();
    await expect(p).toHaveURL(baseUrl+'/planejamento/'+working.publicId);await expect(editor(p).getByText('Concluído',{exact:true})).toBeVisible();
    await editor(p).getByRole('button',{name:'Reutilizar em outra turma'}).click();await dialog(p).getByLabel('Turma de destino').selectOption(targetId);await dialog(p).getByLabel('Novo início').fill('2026-10-05');
    await capture(p,'duplicate');
    const duplicateUrl='**/api/lesson-plans/'+working.publicId+'/duplicate';let posts=0;
    const duplicatePending=gate();await p.route(duplicateUrl,async r=>{posts++;await r.fetch();duplicatePending.started();await duplicatePending.wait;await r.fulfill({status:503,json:{error:'Resposta perdida no teste'}});});
    try{await dialog(p).getByRole('button',{name:'Criar cópia',exact:true}).click();await duplicatePending.ready;await p.goBack();await expect(pendingDialog(p)).toBeVisible();await expect(pendingDialog(p).getByRole('button',{name:'Sair sem salvar',exact:true})).toHaveCount(0);await pendingDialog(p).getByRole('button',{name:'Ficar nesta tela',exact:true}).click();await expect(dialog(p).getByLabel('Título da cópia')).toBeDisabled();}
    finally{duplicatePending.release();}
    await expect(dialog(p).getByRole('button',{name:'Conferir envio'})).toBeVisible();await expect(dialog(p).getByLabel('Título da cópia')).toBeDisabled();assert.equal(posts,1);await capture(p,'duplicate-uncertain');
    await p.unroute(duplicateUrl);await dialog(p).getByRole('button',{name:'Conferir envio'}).click();await expect(dialog(p)).toHaveCount(0);await expect(editor(p).getByRole('heading',{name:'Editar planejamento'})).toBeVisible();
    assert.equal(db.prepare("SELECT COUNT(*) FROM teaching_plans WHERE duplicated_from_plan_id=(SELECT id FROM teaching_plans WHERE public_id=?)").pluck().get(working.publicId),1);
    await expect(editor(p).getByLabel('Observações do professor')).toHaveValue('');
    check('Criação e reuso pendentes não permitem sair; respostas incertas reconciliadas geram uma única gravação e navegam ao plano salvo sem bloqueio residual; conflito e notas locais preservados');

    // Read-only UI boundary fixtures; never send these synthetic oversized catalogues to a write route.
    const bc=await context(320,600,'light'),bp=await bc.newPage();
    const boundaryPlan={...(await latest()),status:'draft',lessons:[{...(await latest()).lessons[0],status:'planned',resources:Array.from({length:49},(_,i)=>({type:'activity',title:'Atividade '+(i+1),notes:'Orientação '+(i+1)}))}]};
    await bp.route('**/api/lesson-plans/'+working.publicId,r=>{assert.equal(r.request().method(),'GET');return r.fulfill({status:200,json:{plan:boundaryPlan}});});
    const extraSkills=Array.from({length:11},(_,i)=>({id:90000+i,code:'QA-LIMITE-'+i,description:'Habilidade artificial para limite de seleção'}));
    await bp.route('**/api/lesson-plans/catalog/skills?*',r=>r.fulfill({status:200,json:{units:[{id:1,name:'Unidade de teste'}],skills:extraSkills}}));await open(bp);await editor(bp).getByRole('button',{name:'Escolher habilidades bncc',exact:true}).click();
    for(let i=0;i<9;i++)await dialog(bp).getByRole('checkbox').nth(i).check();await dialog(bp).getByRole('checkbox').nth(9).click();await expect(dialog(bp).getByRole('alert')).toContainText('no máximo 10');await expect(dialog(bp).getByRole('checkbox').nth(9)).not.toBeChecked();await capture(bp,'skills-limit');
    await dialog(bp).getByText('Selecionadas · 10/10',{exact:true}).click();await dialog(bp).getByRole('button',{name:'Remover QA-LIMITE-0',exact:true}).click();await dialog(bp).getByRole('checkbox').nth(9).check();await dialog(bp).getByRole('button',{name:'Cancelar',exact:true}).click();await discard(bp);
    await editor(bp).getByRole('button',{name:'Escolher recursos da aula',exact:true}).click();await dialog(bp).getByLabel('Tipo de recurso').selectOption('activity');await dialog(bp).getByLabel('Atividade',{exact:true}).fill('Última atividade permitida');await dialog(bp).getByRole('button',{name:'Adicionar atividade',exact:true}).click();await dialog(bp).getByLabel('Atividade',{exact:true}).fill('Não ultrapassar cinquenta');await dialog(bp).getByRole('button',{name:'Adicionar atividade',exact:true}).click();await expect(dialog(bp).getByRole('alert')).toContainText('no máximo 50');await expect(dialog(bp).getByLabel('Atividade',{exact:true})).toHaveValue('Não ultrapassar cinquenta');await capture(bp,'resources-limit');
    await dialog(bp).getByText('Selecionados · 50/50',{exact:true}).click();await dialog(bp).getByRole('button',{name:'Remover recurso 1',exact:true}).click();await dialog(bp).getByRole('button',{name:'Adicionar atividade',exact:true}).click();await expect(dialog(bp).getByLabel('Atividade',{exact:true})).toHaveValue('');await pFocusClose(bp);await discard(bp);await bc.close();
    check('Limites visíveis de 10 habilidades e 50 recursos, remoção e cancelamento em celular; fixtures de leitura sem gravação');

    const lc=await context(),lp=await lc.newPage(),listRows=(await api('/lesson-plans')).plans;
    await lp.route('**/api/lesson-plans?*',r=>r.fulfill({status:200,json:{plans:Array.from({length:100},(_,i)=>({...listRows[0],publicId:'ui-row-'+i,title:'Planejamento '+(i+1)}))}}));await go(lp);await expect(lp.getByText('A consulta mostra até 100.',{exact:false})).toBeVisible();await expect(lp.locator('[data-planner-row]')).toHaveCount(20);await lp.getByRole('button',{name:'Próxima',exact:true}).click();await expect(lp.locator('[data-planner-row]').first()).toContainText('Planejamento 21');assert.match(lp.url(),/pagina=2/);await lp.getByRole('button',{name:'Anterior',exact:true}).click();
    await lp.unroute('**/api/lesson-plans?*');let releaseOld,oldStarted;const oldReady=new Promise(resolve=>{oldStarted=resolve;});const oldGate=new Promise(resolve=>{releaseOld=resolve;});
    await lp.route('**/api/lesson-plans?*',async r=>{const old=new URL(r.request().url()).searchParams.get('search')==='antiga';if(old){oldStarted();await oldGate;}await r.fulfill({status:200,json:{plans:[{...listRows[0],title:old?'Resposta antiga':'Resposta atual'}]}}).catch(()=>{});});
    await lp.getByLabel('Buscar planejamento').fill('antiga');await lp.getByRole('button',{name:'Buscar',exact:true}).click();await oldReady;await lp.getByLabel('Buscar planejamento').fill('atual');await lp.getByRole('button',{name:'Buscar',exact:true}).click();await expect(lp.locator('[data-planner-row]')).toContainText('Resposta atual');releaseOld();await lp.waitForLoadState('networkidle');await expect(lp.locator('[data-planner-row]')).not.toContainText('Resposta antiga');
    await lp.unroute('**/api/lesson-plans?*');await lp.route('**/api/lesson-plans?*',r=>r.fulfill({status:200,json:{plans:[]}}));await go(lp);await expect(lp.getByRole('heading',{name:'Você ainda não criou um planejamento'})).toBeVisible();await capture(lp,'true-empty');await lc.close();
    check('Paginação de 100 resultados em blocos de 20, vazio real e resposta antiga descartada após nova busca');
    const authPlan=(await api('/lesson-plans','POST',{...baseBody,title:'Proteção de sessão QA'})).plan;
    for(const mode of ['expired','logout']){
      const ac=await context(),ap=await ac.newPage();await go(ap,'/planejamento/'+authPlan.publicId);await editor(ap).getByLabel('Observações do professor').fill('Texto sintético antes da mudança de sessão.');
      if(mode==='expired'){
        await ap.route(baseUrl+'/api/lesson-plans/'+authPlan.publicId,r=>{assert.equal(r.request().method(),'PUT');return r.fulfill({status:401,json:{error:'Sessão expirada no ensaio'}});});
        await editor(ap).getByRole('button',{name:'Salvar rascunho',exact:true}).click();
      }else{
        await ap.getByRole('button',{name:'Menu do usuário',exact:true}).click();await ap.getByRole('button',{name:'Sair da conta',exact:true}).click();
      }
      await expect(ap).toHaveURL(/\/login(?:\?|$)/);await expect(leaveDialog(ap)).toHaveCount(0);await expect(pendingDialog(ap)).toHaveCount(0);await ac.close();
    }
    check('Escape no guard aninhado restaura foco ao picker sem perder seleção; logout e 401 continuam levando ao login, sem aprisionar a sessão no guard');
    assert.deepEqual(report.pageErrors,[]);report.status='captured';record();return report;
  }catch(error){report.status='failed';report.error=error.stack;record();throw error;}
  finally{for(const c of contexts)await c.close().catch(()=>{});await browser.close();}
}
module.exports={runPlannerLayoutBrowser};
async function pFocusClose(p){await p.getByRole('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();}
