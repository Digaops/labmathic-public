const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runExecutionLayoutBrowser({ baseUrl, teacher, tokenFor, classPublicId, assessmentPublicId, db, output }) {
  assert.equal(process.env.EXECUTION_LAYOUT_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output, path.join(root, 'tmp/execution-layout-qa'));
  const token = tokenFor(teacher);
  // Restore this fixture's curated link removed by its discovery test; never touches real data.
  db.prepare('INSERT OR IGNORE INTO material_bncc_skills(material_id,skill_id,linked_by) SELECT m.id,s.id,m.created_by FROM materials m JOIN bncc_skills s ON s.code=? WHERE m.title=?').run('EF07MA02','Caderno de números racionais');
  let operation = 0;
  async function api(url, method='GET', body) {
    const response = await fetch(baseUrl+'/api'+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'execution-layout-fixture-'+(++operation)},...(body ? {body:JSON.stringify(body)} : {})});
    const value = await response.json(); assert.ok(response.ok, url+': '+JSON.stringify(value)); return value;
  }
  // Create a second diagnostic via the real API; no reopening or deleting historical plans.
  const source = db.prepare('SELECT source_question_set_id FROM class_assessment_assignments WHERE public_id=?').pluck().get(assessmentPublicId);
  const participants = db.prepare(`SELECT s.public_id FROM students s JOIN school_class_enrollments e ON e.student_id=s.id JOIN school_classes c ON c.id=e.class_id WHERE c.public_id=? AND e.status='active'`).all(classPublicId).map(s=>s.public_id);
  async function createDiagnostic() {
  const assignment = await api(`/classes/${classPublicId}/assessments`,'POST',{sourceQuestionSetId:source,participantIds:participants});
  const draftAssessmentId = assignment.id;
  const assignmentPath = `/classes/${classPublicId}/assessments/${draftAssessmentId}`;
  const opened = await api(assignmentPath+'/delivery','PATCH',{expectedRevision:assignment.revision,action:'open'});
  for (const id of participants.slice(0,2)) {
    const entry = await api(assignmentPath+'/results/participants/'+id);
    const saved = await api(assignmentPath+'/results/participants/'+id,'PUT',{expectedRevision:0,responses:entry.items.map(item=>({itemId:item.id,optionId:db.prepare('SELECT id FROM class_assessment_item_options WHERE assessment_item_id=? AND is_correct=0 LIMIT 1').pluck().get(item.id)}))});
    await api(assignmentPath+'/results/participants/'+id+'/submit','POST',{expectedRevision:saved.attempt.revision});
  }
  await api(assignmentPath+'/delivery','PATCH',{expectedRevision:opened.revision,action:'close'});
  const preview = await api(assignmentPath+'/results/recovery-preview');
  assert.ok(preview.isActionable);
  return {draftAssessmentId,assignmentPath,preview};
  }
  const {draftAssessmentId,assignmentPath,preview} = await createDiagnostic();
  const payload = {expectedAssessmentRevision:preview.source.assessment.revision,expectedResultRevision:preview.source.resultRevision,methodologyVersion:preview.methodology.version,title:'Plano de apoio · leitura dos números',acceptedPriorities:preview.priorities.filter(p=>p.skill.code==='EF07MA02').map(p=>({skillId:p.skill.id,suggestedQuestionCount:2,group:{title:p.suggestedGroup.title,objective:p.suggestedGroup.objective,studentIds:p.suggestedGroup.students.map(s=>s.id)}}))};
  const draft = (await api(assignmentPath+'/results/recovery-plans','POST',payload)).plan;

  const basePath=assignmentPath+'/results/recovery-plans/'+draft.id;
  await api(basePath+'/activate','POST',{...payload,expectedPlanRevision:draft.revision,reviewConfirmed:true});
  const report={status:'running',syntheticDataOnly:true,inventory:[],cases:[],internal:[],pageErrors:[]};
  const record=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  const check=description=>{report.inventory.push({description});record();console.log('Execução:',description);};
  record();
  if(process.env.EXECUTION_LAYOUT_INTERACTIVE==='1'){
    const connection=path.join(output,'interactive-connection.json'),stop=path.join(output,'interactive-stop');
    if(fs.existsSync(stop))fs.unlinkSync(stop);
    fs.writeFileSync(connection,JSON.stringify({baseUrl,teacher,token,classPublicId,basePath,planId:draft.id,url:'/recomposicao'}));
    console.log('EXECUTION_LAYOUT_INTERACTIVE_READY');
    try{await new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(fs.existsSync(stop)){clearInterval(timer);clearTimeout(expiry);resolve();}},250);const expiry=setTimeout(()=>{clearInterval(timer);reject(Error('Interactive fixture expired'));},480000);});}
    finally{if(fs.existsSync(connection))fs.unlinkSync(connection);if(fs.existsSync(stop))fs.unlinkSync(stop);}
    return {...report,status:'captured'};
  }
  const browser=await chromium.launch({headless:true}),contexts=[];
  async function context(width=1024,height=600,theme='dark'){
    const c=await browser.newContext({viewport:{width,height},colorScheme:theme,...(width<600?{isMobile:true,hasTouch:true}:{})});contexts.push(c);c.setDefaultTimeout(6000);
    await c.route('**/*',r=>r.request().url().startsWith(baseUrl+'/')?r.continue():r.abort());
    await c.addInitScript(({baseUrl,teacher,token,theme})=>{if(location.origin===baseUrl){localStorage.setItem('theme',theme);sessionStorage.setItem('labmathic_auth_session_v1',JSON.stringify({user:teacher,token}));}},{baseUrl,teacher,token,theme});
    c.on('page',p=>p.on('pageerror',e=>report.pageErrors.push(e.message)));return c;
  }
  async function open(p,planId=draft.id){
    await p.goto(baseUrl+'/recomposicao');await p.waitForLoadState('networkidle');
    const notice=p.getByRole('button',{name:'Entendi, continuar'});if(await notice.isVisible())await notice.click();
    await p.locator('[data-recovery-plan="'+planId+'"]').getByRole('button').click();
    await expect(p.locator('[data-recovery-execution]')).toBeVisible();
  }
  const stage=p=>p.getByRole('combobox',{name:'Etapa do plano'});
  const lesson=p=>p.locator('[data-execution-lesson]:visible');
  const notes=p=>lesson(p).getByLabel('Registro do professor');
  async function capture(p,name){
    await p.screenshot({path:path.join(output,name+'.png'),scale:'css'});
    const metrics=await p.evaluate(()=>{
      const d=document.querySelector('[role=dialog]'),scope=d.querySelector('[data-recovery-execution]');
      const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,right:b.right,bottom:b.bottom};};
      return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dialog:{...box(d),scroll:d.scrollWidth,client:d.clientWidth},
        controls:[...scope.querySelectorAll('button,a,input,textarea,select,summary')].filter(e=>e.getClientRects().length&&!e.closest('details:not([open]) :not(summary)')).map(e=>({label:e.getAttribute('aria-label')||e.textContent.slice(0,45),...box(e.matches('input[type=checkbox]')?e.closest('label')||e:e)}))};
    });
    report.cases.push({name,...metrics});record();
    assert.ok(metrics.scrollWidth<=metrics.width+1,name+': page overflow');assert.ok(metrics.dialog.scroll<=metrics.dialog.client+1,name+': dialog overflow');
    assert.ok(metrics.dialog.y>=0&&metrics.dialog.bottom<=metrics.height+1,name+': dialog fits');
    for(const control of metrics.controls){assert.ok(control.w>=43.5&&control.h>=43.5,name+': target '+control.label);assert.ok(control.x>=0&&control.right<=metrics.width+1,name+': bounds '+control.label);}
  }
  const current=async()=> (await api(basePath)).plan;
  async function remoteNote(text){
    const plan=await current(),l=plan.execution.lessons[0];
    return api(basePath+'/execution/lessons/'+l.id,'PUT',{expectedRevision:l.revision,plannedDate:l.plannedDate,durationMinutes:50,teacherNotes:text,status:l.status});
  }
  try{
    check('Plano ativado por API real, banco e contas sintéticos; histórico anterior preservado');
    for(const [w,h] of [[1024,600],[390,664],[320,600]])for(const theme of ['dark','light']){
      const c=await context(w,h,theme),p=await c.newPage();await open(p);await capture(p,'schedule-'+w+'-'+theme);
      await expect(p.getByRole('option',{name:'A cada 5 dias',exact:true})).toHaveCount(1);
      await p.keyboard.press('Escape');await c.close();
    }
    const c=await context(),p=await c.newPage();await open(p);
    await p.getByRole('dialog').getByRole('button',{name:'Organizar aulas',exact:true}).click();await expect(stage(p)).toBeVisible();
    const initial=await current(),ids=initial.execution.lessons.map(l=>l.id);
    await notes(p).fill('Minha anotação ainda não salva');
    await stage(p).selectOption(ids[1]);await expect(p.getByText('A verificação será liberada depois das intervenções')).toBeVisible();
    await stage(p).selectOption(ids[0]);await expect(notes(p)).toHaveValue('Minha anotação ainda não salva');
    await p.getByRole('button',{name:'Revisar recursos',exact:true}).click();
    const picker=p.locator('[data-execution-resources]');
    await expect(picker.getByRole('checkbox').first()).toBeVisible();
    await picker.getByRole('checkbox').first().uncheck();
    await expect(lesson(p).getByRole('button',{name:'Registrar realizada',exact:true})).toBeDisabled();
    await picker.getByLabel('Buscar recurso').fill('não existe 999');
    await expect(picker.getByText(/Nenhum recurso nesta busca/)).toBeVisible();
    await picker.getByLabel('Buscar recurso').fill('');
    await picker.getByRole('button',{name:'Salvar recursos',exact:true}).click();
    await expect(picker).toHaveCount(0);await expect(notes(p)).toHaveValue('Minha anotação ainda não salva');
    assert.notEqual((await current()).execution.lessons[0].teacherNotes,'Minha anotação ainda não salva');
    p.once('dialog',d=>d.dismiss());await p.keyboard.press('Escape');await expect(stage(p)).toBeVisible();
    await lesson(p).getByRole('button',{name:'Salvar ajustes',exact:true}).click();
    await expect(lesson(p).getByText('Não salvo',{exact:true})).toHaveCount(0);
    check('Troca de etapa, recursos e fechamento mantêm anotações; recursos não salvam texto implicitamente');

    await notes(p).fill('Texto local em conflito');await remoteNote('Texto remoto confirmado');
    await lesson(p).getByRole('button',{name:'Salvar ajustes',exact:true}).click();
    await expect(p.getByRole('button',{name:'Conferir servidor',exact:true})).toBeVisible();
    await expect(notes(p)).toHaveValue('Texto local em conflito');
    await p.getByRole('button',{name:'Conferir servidor',exact:true}).click();
    await expect(lesson(p).getByText('Esta etapa mudou em outro acesso.')).toBeVisible();
    await lesson(p).getByText('Conferir registro salvo',{exact:true}).click();
    await expect(lesson(p).getByText('Texto remoto confirmado',{exact:true})).toBeVisible();
    await capture(p,'conflict-preserved');
    await lesson(p).getByRole('button',{name:'Conferi; manter meu texto',exact:true}).click();
    await lesson(p).getByRole('button',{name:'Salvar ajustes',exact:true}).click();
    await expect(lesson(p).getByText('Não salvo',{exact:true})).toHaveCount(0);
    assert.equal((await current()).execution.lessons[0].teacherNotes,'Texto local em conflito');

    let writes=0;const lost='**/execution/lessons/'+ids[0];
    await p.route(lost,async r=>{writes++;await r.fetch();await r.fulfill({status:503,json:{error:'Resposta perdida no teste'}});});
    await notes(p).fill('Salvo com resposta perdida');await lesson(p).getByRole('button',{name:'Salvar ajustes',exact:true}).click();
    await expect(p.getByRole('button',{name:'Conferir servidor',exact:true})).toBeVisible();
    await expect(lesson(p).getByRole('button',{name:'Salvar ajustes',exact:true})).toBeDisabled();
    assert.equal(writes,1);assert.equal((await current()).execution.lessons[0].teacherNotes,'Salvo com resposta perdida');
    await p.unroute(lost);await p.getByRole('button',{name:'Conferir servidor',exact:true}).click();
    await expect(notes(p)).toHaveValue('Salvo com resposta perdida');
    await lesson(p).getByRole('button',{name:'Descartar minha edição',exact:true}).click();
    check('Conflito e resposta perdida: sem reenvio automático, conferência explícita e texto preservado');

    const optionsUrl='**/execution/lessons/'+ids[0]+'/resources/options';
    await p.route(optionsUrl,r=>r.fulfill({status:200,json:{questions:[]}}));
    await p.getByRole('button',{name:'Revisar recursos',exact:true}).click();
    await expect(picker.getByRole('alert')).toContainText('Não foi possível carregar');
    await capture(p,'resources-invalid-response');await p.unroute(optionsUrl);
    await picker.getByRole('button',{name:'Tentar novamente',exact:true}).click();
    await expect(picker.getByRole('checkbox').first()).toBeVisible();
    await picker.getByRole('button',{name:'Fechar seleção de recursos'}).click();
    await expect(p.getByRole('button',{name:'Revisar recursos',exact:true})).toBeFocused();
    let releaseWrite,enteredWrite;const writeEntered=new Promise(resolve=>{enteredWrite=resolve;}),writeGate=new Promise(resolve=>{releaseWrite=resolve;});
    await p.route(lost,async r=>{const response=await r.fetch();enteredWrite();await writeGate;await r.fulfill({response});});
    await notes(p).fill('Uma gravação protegida');await lesson(p).getByRole('button',{name:'Salvar ajustes',exact:true}).click();await writeEntered;
    await expect(lesson(p).getByRole('button',{name:'Salvar ajustes',exact:true})).toBeDisabled();
    await p.keyboard.press('Escape');await expect(p.getByRole('dialog')).toBeVisible();
    releaseWrite();await expect(lesson(p).getByText('Não salvo',{exact:true})).toHaveCount(0);await p.unroute(lost);
    check('Resposta incompleta de recursos não vira vazio; recuperação e foco; fechamento bloqueado enquanto a gravação termina');

    for(const [w,h] of [[1024,600],[390,664],[320,600]])for(const theme of ['dark','light']){
      const vc=await context(w,h,theme),vp=await vc.newPage();await open(vp);
      await stage(vp).scrollIntoViewIfNeeded();await capture(vp,'lesson-'+w+'-'+theme);
      await notes(vp).scrollIntoViewIfNeeded();await capture(vp,'notes-'+w+'-'+theme);
      await lesson(vp).getByText('Objetivo, habilidades e grupos',{exact:true}).click();await capture(vp,'details-'+w+'-'+theme);
      await vp.getByRole('button',{name:'Revisar recursos',exact:true}).click();await vp.locator('[data-execution-resources]').getByRole('checkbox').first().waitFor();await vp.locator('[data-execution-resources]').getByRole('checkbox').first().focus();await capture(vp,'resources-'+w+'-'+theme);
      await vp.locator('[data-execution-resources]').getByText('Caderno de números racionais',{exact:true}).scrollIntoViewIfNeeded();await capture(vp,'materials-'+w+'-'+theme);
      await vp.getByRole('button',{name:'Fechar seleção de recursos'}).click();
      await vc.close();
    }
    // Fresh context after the responsive matrix.
    const cc=await context(),pp=await cc.newPage();await open(pp);
    await lesson(pp).getByRole('button',{name:'Registrar realizada',exact:true}).click();
    await expect(lesson(pp).getByRole('button',{name:'Registrar realizada',exact:true})).toHaveCount(0);
    await stage(pp).selectOption(ids[1]);await pp.getByRole('button',{name:'Escolher questões da verificação',exact:true}).click();
    await expect(pp.getByRole('button',{name:'Salvar questões da verificação',exact:true})).toBeEnabled();
    await pp.getByRole('checkbox').first().uncheck();
    pp.once('dialog',d=>d.dismiss());await pp.getByRole('button',{name:'Cancelar seleção',exact:true}).click();
    await expect(pp.getByRole('button',{name:'Salvar questões da verificação',exact:true})).toBeVisible();
    pp.once('dialog',d=>d.accept());await pp.getByRole('button',{name:'Cancelar seleção',exact:true}).click();
    await expect(pp.getByRole('button',{name:'Escolher questões da verificação',exact:true})).toBeVisible();
    const monitoringUrl='**/execution/monitoring/options';
    await pp.route(monitoringUrl,async r=>{const response=await r.fetch(),data=await response.json();await r.fulfill({json:{...data,ready:false,skills:data.skills.map(s=>({...s,questions:[]})),warnings:['Nenhuma questão inédita disponível nesta simulação de indisponibilidade.']}});});
    await pp.getByRole('button',{name:'Escolher questões da verificação',exact:true}).click();
    await expect(pp.getByText('Nenhuma questão inédita disponível nesta simulação de indisponibilidade.')).toBeVisible();
    await expect(pp.getByRole('button',{name:'Salvar questões da verificação',exact:true})).toBeDisabled();await capture(pp,'monitoring-unavailable');
    await pp.unroute(monitoringUrl);await pp.getByRole('button',{name:'Atualizar opções da verificação',exact:true}).click();
    await expect(pp.getByRole('button',{name:'Salvar questões da verificação',exact:true})).toBeEnabled();
    await pp.getByRole('checkbox').first().uncheck();
    if(await pp.getByRole('checkbox').count()===1)await expect(pp.getByRole('button',{name:'Salvar questões da verificação',exact:true})).toBeDisabled();
    await pp.getByRole('checkbox').first().check();await capture(pp,'monitoring-selection');
    await pp.getByRole('button',{name:'Salvar questões da verificação',exact:true}).click();
    await expect(pp.getByRole('link',{name:'Abrir aplicações da turma'})).toBeVisible();
    const monitoring=(await current()).execution.monitoring;
    assert.equal(monitoring.state,'needs_application');
    const assignment=await api('/classes/'+classPublicId+'/assessments','POST',{sourceQuestionSetId:monitoring.questionSet.id,participantIds:participants});
    const ap='/classes/'+classPublicId+'/assessments/'+assignment.id;
    const opened=await api(ap+'/delivery','PATCH',{expectedRevision:assignment.revision,action:'open'});
    const entry=await api(ap+'/results/participants/'+participants[0]);
    const saved=await api(ap+'/results/participants/'+participants[0],'PUT',{expectedRevision:0,responses:entry.items.map(item=>({itemId:item.id,optionId:db.prepare('SELECT id FROM class_assessment_item_options WHERE assessment_item_id=? AND is_correct=1 LIMIT 1').pluck().get(item.id)}))});
    await api(ap+'/results/participants/'+participants[0]+'/submit','POST',{expectedRevision:saved.attempt.revision});
    await api(ap+'/delivery','PATCH',{expectedRevision:opened.revision,action:'close'});
    await pp.getByRole('button',{name:'Atualizar acompanhamento',exact:true}).click();
    await expect(pp.getByText('Resultados da verificação',{exact:true})).toBeVisible();
    await expect(lesson(pp).getByRole('button',{name:'Registrar realizada',exact:true})).toBeEnabled();
    for(const [w,h] of [[1024,600],[390,664],[320,600]])for(const theme of ['dark','light']){
      const vc=await context(w,h,theme),vp=await vc.newPage();await open(vp);await stage(vp).selectOption(ids[1]);
      await vp.getByText('Situação atual:',{exact:false}).scrollIntoViewIfNeeded();await capture(vp,'comparison-'+w+'-'+theme);await vc.close();
    }
    await lesson(pp).getByRole('button',{name:'Registrar realizada',exact:true}).click();
    await expect(pp.getByRole('button',{name:'Concluir ciclo',exact:true})).toBeEnabled();
    await notes(pp).fill('Última anotação');await expect(pp.getByRole('button',{name:'Concluir ciclo',exact:true})).toBeDisabled();
    await lesson(pp).getByRole('button',{name:'Salvar ajustes',exact:true}).click();
    await pp.getByRole('button',{name:'Concluir ciclo',exact:true}).click();
    assert.equal((await current()).status,'active');
    const other=await cc.newPage();await open(other);await stage(other).selectOption(ids[1]);await notes(other).fill('Anotação preservada após encerramento em outro acesso');
    await pp.getByRole('button',{name:'Confirmar conclusão',exact:true}).click();
    await expect(pp.getByRole('heading',{name:'Ciclo concluído',exact:true})).toBeVisible();
    await expect(lesson(pp).getByLabel('Registro do professor')).toHaveCount(0);await capture(pp,'completed-history');
    assert.equal((await current()).status,'completed');
    await other.getByRole('button',{name:'Atualizar acompanhamento',exact:true}).click();
    await expect(other.getByLabel('Anotações locais')).toHaveValue('Anotação preservada após encerramento em outro acesso');
    await capture(other,'remote-completion-preserved');other.once('dialog',d=>d.dismiss());await other.getByRole('button',{name:'Descartar minha edição',exact:true}).click();
    await expect(other.getByLabel('Anotações locais')).toBeVisible();other.once('dialog',d=>d.accept());await other.getByRole('button',{name:'Descartar minha edição',exact:true}).click();await expect(other.getByLabel('Anotações locais')).toHaveCount(0);
    check('Verificação inédita, aplicação, respostas, comparação e conclusão explícita por APIs reais; histórico somente leitura');
    check('Três resoluções, dois temas, notas, recursos, detalhes e comparação: controles de 44 px, uma rolagem, sem transbordamento');
    assert.deepEqual(report.pageErrors,[]);report.status='captured';record();return report;
  }catch(error){report.status='failed';report.error=error.stack;record();throw error;}
  finally{for(const c of contexts)await c.close().catch(()=>{});await browser.close();}
}
module.exports={runExecutionLayoutBrowser};
