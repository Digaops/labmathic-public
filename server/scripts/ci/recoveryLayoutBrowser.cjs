const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runRecoveryLayoutBrowser({ baseUrl, teacher, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output }) {
  assert.equal(process.env.RECOVERY_LAYOUT_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output, path.join(root, 'tmp/recovery-layout-qa'));
  const token = tokenFor(teacher);
  let operation = 0;
  async function api(url, method='GET', body) {
    const response = await fetch(baseUrl+'/api'+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'recovery-layout-fixture-'+(++operation)},...(body ? {body:JSON.stringify(body)} : {})});
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
  const payload = {expectedAssessmentRevision:preview.source.assessment.revision,expectedResultRevision:preview.source.resultRevision,methodologyVersion:preview.methodology.version,title:'Plano de apoio · leitura dos números',acceptedPriorities:preview.priorities.map(p=>({skillId:p.skill.id,suggestedQuestionCount:3,group:{title:p.suggestedGroup.title,objective:p.suggestedGroup.objective,studentIds:p.suggestedGroup.students.map(s=>s.id)}}))};
  const draft = (await api(assignmentPath+'/results/recovery-plans','POST',payload)).plan;
  const report = {status:'running',syntheticDataOnly:true,inventory:[],cases:[],internal:[],pageErrors:[]};
  const record = () => fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  const check = description => {report.inventory.push({description});record();console.log('Recomposição:',description);};
  record();
  if(process.env.RECOVERY_LAYOUT_INTERACTIVE === '1') {
    const connection = path.join(output,'interactive-connection.json'), stop = path.join(output,'interactive-stop');
    if(fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(connection,JSON.stringify({baseUrl,teacher,token,classPublicId,assessmentPublicId,draftAssessmentId,draftPlanId:draft.id,url:'/recomposicao'}));
    console.log('RECOVERY_LAYOUT_INTERACTIVE_READY');
    try {await new Promise((resolve,reject)=>{
      const timer=setInterval(()=>{if(fs.existsSync(stop)){clearInterval(timer);clearTimeout(expiry);resolve();}},250);
      const expiry=setTimeout(()=>{clearInterval(timer);reject(Error('Interactive fixture expired'));},480000);
    });} finally {if(fs.existsSync(connection))fs.unlinkSync(connection);if(fs.existsSync(stop))fs.unlinkSync(stop);}
    return {...report,status:'captured'};
  }
  // Focused interactive/visual checks are below; all API writes stay in this fixture.
  const browser = await chromium.launch({headless:true}), contexts=[];
  async function context(width=390,height=664,theme='dark',user=teacher) {
    const c = await browser.newContext({viewport:{width,height},colorScheme:theme,...(width<600?{isMobile:true,hasTouch:true}:{})});contexts.push(c);c.setDefaultTimeout(6000);
    await c.route('**/*',r=>r.request().url().startsWith(baseUrl+'/')?r.continue():r.abort());
    await c.addInitScript(({origin,user,token,theme})=>{if(location.origin===origin){localStorage.setItem('theme',theme);sessionStorage.setItem('labmathic_auth_session_v1',JSON.stringify({user,token}));}},{origin:baseUrl,user,token:tokenFor(user),theme});
    c.on('page',p=>p.on('pageerror',e=>report.pageErrors.push(e.message)));return c;
  }
  async function go(p,url='/recomposicao') {
    await p.goto(baseUrl+url);await p.waitForLoadState('networkidle');
    const notice=p.getByRole('button',{name:'Entendi, continuar'});if(await notice.isVisible()){await notice.click();await p.waitForLoadState('networkidle');}
  }
  const title = p => p.getByRole('dialog').getByLabel('Título do plano',{exact:true});
  const save = p => p.getByRole('button',{name:'Salvar rascunho',exact:true});
  const activate = p => p.getByRole('button',{name:'Concluir revisão',exact:true});
  const confirm = p => p.getByRole('checkbox',{name:/^Conferi o plano/});
  const row = p => p.locator(`[data-recovery-plan="${draft.id}"]`);
  async function openDraft(p) {await row(p).getByRole('button',{name:'Continuar revisão'}).click();await expect(title(p)).toBeVisible();}
  async function capture(p,name,primary=null) {
    await p.screenshot({path:path.join(output,name+'.png'),scale:'css'});
    fs.writeFileSync(path.join(output,name+'.txt'),await p.locator('body').innerText());
    const metrics=await p.evaluate(()=>{
      const d=document.querySelector('[role="dialog"]'),scope=d?.querySelector('[data-recovery-review]')||document.querySelector('[data-recovery-plans]');
      const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,right:b.right,bottom:b.bottom};};
      return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dialog:d?{...box(d),client:d.clientWidth,scroll:d.scrollWidth}:null,
        controls:[...scope.querySelectorAll('button,a,input,select,summary,textarea')].filter(e=>e.getClientRects().length&&!e.closest('details:not([open]) :not(summary)')).map(e=>({label:e.getAttribute('aria-label')||e.textContent.slice(0,40),...box(e.matches('input[type=checkbox]')?e.closest('label')||e:e)}))};
    });
    report.cases.push({name,...metrics});record();
    assert.equal(metrics.width,p.viewportSize().width,name+': viewport');assert.ok(metrics.scrollWidth<=metrics.width+1,name+': overflow');
    if(metrics.dialog){assert.ok(metrics.dialog.y>=0 && metrics.dialog.bottom<=metrics.height,name+': dialog fits');assert.ok(metrics.dialog.scroll<=metrics.dialog.client+1,name+': dialog overflow');}
    for(const control of metrics.controls) {assert.ok(control.w>=43.5&&control.h>=43.5,name+': target '+control.label);assert.ok(control.x>=0&&control.right<=metrics.width+1,name+': bounds '+control.label);}
    if(primary){const b=await primary.boundingBox();assert.ok(b&&b.y>=0&&b.y+b.height<=metrics.height,name+': primary visible');}
  }
  try {
    check('Diagnóstico novo, correções, encerramento e rascunho criados por APIs reais no banco temporário');
    for(const [width,height] of [[1024,600],[390,664],[320,600]]) for(const theme of ['dark','light']) {
      const c=await context(width,height,theme),p=await c.newPage();await go(p);
      await capture(p,`list-${width}-${theme}`,row(p).getByRole('button',{name:'Continuar revisão'}));
      await row(p).locator('summary').click();await capture(p,`list-details-${width}-${theme}`);await row(p).locator('summary').click();
      await openDraft(p);await capture(p,`review-${width}-${theme}`,title(p));
      const priority=p.locator('[data-recovery-priority]').first();
      await priority.getByText('Sugestões disponíveis e evidências',{exact:true}).click();await priority.getByRole('combobox').scrollIntoViewIfNeeded();await capture(p,`fields-${width}-${theme}`);
      await priority.getByLabel('Nome do grupo',{exact:true}).scrollIntoViewIfNeeded();await capture(p,`group-${width}-${theme}`);
      await confirm(p).scrollIntoViewIfNeeded();await capture(p,`confirm-${width}-${theme}`);await expect(activate(p)).toBeDisabled();
      await confirm(p).check();await expect(activate(p)).toBeEnabled();await priority.getByRole('button',{name:'Recolher detalhes'}).click();await expect(confirm(p)).toBeChecked();
      await priority.getByRole('button',{name:'Expandir detalhes'}).click();await expect(confirm(p)).toBeChecked();await confirm(p).uncheck();
      await p.keyboard.press('Escape');await expect(p.getByRole('dialog')).toHaveCount(0);await expect(row(p).getByRole('button')).toBeFocused();
      await p.getByRole('button',{name:'Ver histórico',exact:true}).click();await expect(p.getByRole('dialog').getByRole('heading',{name:'Ciclo concluído',exact:true})).toBeVisible();await capture(p,`history-${width}-${theme}`);
      const group=p.getByRole('dialog').locator('section').filter({has:p.getByRole('heading',{name:'Grupos temporários de apoio',exact:true})}).locator('article').first();
      await group.scrollIntoViewIfNeeded();await capture(p,`history-group-${width}-${theme}`,group);await p.keyboard.press('Escape');await c.close();
    }
    check('Lista, metadados, prioridades, campos, grupos e confirmação em 3 resoluções × 2 temas; tarefa inicial visível, controles de 44 px e uma rolagem');
    const c=await context(1024,600),p=await c.newPage();await go(p);
    await p.getByRole('searchbox',{name:'Buscar plano',exact:true}).fill('nenhum plano assim');await p.getByRole('button',{name:'Buscar',exact:true}).click();await expect(p.getByRole('heading',{name:'Nenhum plano neste filtro'})).toBeVisible();assert.match(p.url(),/busca=/);await capture(p,'empty-filter');
    await p.getByRole('button',{name:'Limpar filtros'}).click();await expect(row(p)).toBeVisible();
    await p.getByLabel('Situação',{exact:true}).selectOption('completed');await expect(row(p)).toHaveCount(0);await expect(p.getByRole('button',{name:'Ver histórico'})).toBeVisible();
    await p.reload();await expect(p.getByLabel('Situação',{exact:true})).toHaveValue('completed');await p.goBack();await expect(row(p)).toBeVisible();
    const listUrl=baseUrl+'/api/classes/recovery-plans*';
    await p.route(listUrl,r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));await go(p);
    await expect(p.getByRole('alert')).toContainText('Não foi possível carregar');await expect(p.getByText('Nenhum plano criado ainda',{exact:true})).toHaveCount(0);await capture(p,'list-error');
    await p.unroute(listUrl);await p.getByRole('button',{name:'Tentar novamente'}).click();await expect(row(p)).toBeVisible();
    let releaseRead;const readGate=new Promise(resolve=>releaseRead=resolve);
    await p.route(listUrl,async r=>{if(new URL(r.request().url()).searchParams.get('search')==='lenta'){await readGate;}await r.continue().catch(()=>{});});
    await p.getByRole('searchbox',{name:'Buscar plano',exact:true}).fill('lenta');await p.getByRole('button',{name:'Buscar',exact:true}).click();
    await expect(p.getByText('Carregando planos…',{exact:true})).toBeVisible();await p.getByRole('searchbox',{name:'Buscar plano',exact:true}).fill('');await p.getByRole('button',{name:'Buscar',exact:true}).click();await expect(row(p)).toBeVisible();releaseRead();await p.unroute(listUrl);await expect(row(p)).toBeVisible();
    check('Busca e situação na URL, voltar/recarregar, vazio do filtro, erro sem falso vazio e consulta antiga descartada');
    const realList=await api('/classes/recovery-plans?limit=100');
    await p.route(listUrl,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...realList,data:Array.from({length:100},(_,i)=>({...realList.data[0],id:'synthetic-list-'+i,title:'Plano sintético '+i}))})}));await go(p);
    await expect(p.locator('[data-recovery-plan]')).toHaveCount(20);await expect(p.getByText(/Esta consulta trouxe o limite de 100 planos/)).toBeVisible();await p.getByRole('button',{name:'Próxima',exact:true}).click();await expect(p.getByText('Página 2 de 5',{exact:true})).toBeVisible();await expect(p.getByRole('heading',{name:'Plano sintético 20',exact:true})).toBeVisible();await p.getByRole('button',{name:'Anterior',exact:true}).click();await expect(p.getByRole('heading',{name:'Plano sintético 0',exact:true})).toBeVisible();
    await p.unroute(listUrl);await go(p);await p.getByText('Resumo dos meus planos · '+realList.counts.total,{exact:true}).click();await expect(p.getByText('Totais da conta, sem os filtros desta busca.',{exact:true})).toBeVisible();
    const emptyContext=await context(390,664,'dark',previewUser),emptyPage=await emptyContext.newPage();await go(emptyPage);await expect(emptyPage.getByRole('heading',{name:'Nenhum plano criado ainda'})).toBeVisible();await capture(emptyPage,'empty-real');await emptyContext.close();
    check('Páginas locais, teto de 100 explicitado, totais globais separados do filtro e conta sem planos');
    const detailUrl=baseUrl+'/api'+assignmentPath+'/results/recovery-plans/'+draft.id;
    const initialPlan=await api(assignmentPath+'/results/recovery-plans/'+draft.id);
    await p.route(detailUrl,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({plan:{...initialPlan.plan,class:{...initialPlan.plan.class,id:'outra-turma'}}})}));
    await row(p).getByRole('button',{name:'Continuar revisão'}).click();await expect(p.getByRole('heading',{name:'Prévia indisponível'})).toBeVisible();await expect(title(p)).toHaveCount(0);await capture(p,'invalid-plan-context');await p.unroute(detailUrl);await p.getByRole('dialog').getByRole('button',{name:'Tentar novamente'}).click();await expect(title(p)).toHaveValue(draft.title);
    for(const checkbox of await p.getByRole('checkbox',{name:/^Selecionar EF/}).all())await checkbox.uncheck();await expect(save(p)).toBeDisabled();await expect(p.getByText('Selecione ao menos uma prioridade.',{exact:true})).toBeVisible();
    for(const button of await p.getByRole('button',{name:'Expandir detalhes'}).all())await expect(button).toBeDisabled();
    for(const checkbox of await p.getByRole('checkbox',{name:/^Selecionar EF/}).all())await checkbox.check();await expect(save(p)).toBeEnabled();await title(p).fill('');await expect(save(p)).toBeDisabled();
    check('Resposta fora da turma recusada com nova tentativa; seleção de prioridades e título obrigatório conferidos');
    await title(p).fill('Retomada dos números com a turma');
    p.once('dialog',d=>d.dismiss());await p.keyboard.press('Escape');await expect(title(p)).toHaveValue('Retomada dos números com a turma');
    p.once('dialog',d=>d.dismiss());await p.getByRole('dialog').getByRole('button',{name:'Fechar',exact:true}).click();await expect(title(p)).toHaveValue('Retomada dos números com a turma');
    const priority=p.locator('[data-recovery-priority]').first();
    await priority.getByRole('combobox').selectOption('4');await priority.getByRole('textbox',{name:'Por que trabalhar esta habilidade? (opcional)',exact:true}).fill('Retomar estratégias observadas nas respostas.');
    await priority.getByRole('checkbox',{name:/^Alice Estudante/}).uncheck();await priority.getByRole('checkbox',{name:/^Bruno Estudante/}).uncheck();await expect(save(p)).toBeDisabled();await expect(priority.getByRole('alert')).toContainText('Selecione ao menos um estudante');
    await priority.getByRole('checkbox',{name:/^Criar grupo temporário/}).uncheck();await expect(save(p)).toBeEnabled();await priority.getByRole('checkbox',{name:/^Criar grupo temporário/}).check();await priority.getByRole('checkbox',{name:/^Alice Estudante/}).check();
    const writeUrl=baseUrl+'/api'+assignmentPath+'/results/recovery-plans/'+draft.id;
    let writes=0,releaseWrite;const writeGate=new Promise(resolve=>releaseWrite=resolve);
    await p.route(writeUrl,async r=>{if(r.request().method()==='PUT'){writes++;await writeGate;}await r.continue();});
    await save(p).click();await expect(save(p)).toBeDisabled();await expect(title(p)).toBeDisabled();await p.keyboard.press('Escape');await p.getByRole('dialog').getByRole('button',{name:'Fechar',exact:true}).click();await expect(p.getByRole('dialog')).toBeVisible();releaseWrite();
    await expect(save(p)).toBeEnabled();assert.equal(writes,1);await p.unroute(writeUrl);
    const saved=await api(assignmentPath+'/results/recovery-plans/'+draft.id);assert.equal(saved.plan.title,'Retomada dos números com a turma');assert.equal(saved.plan.skills[0].suggestedQuestionCount,4);assert.equal(saved.plan.groups[0].students.length,1);
    await p.keyboard.press('Escape');await expect(row(p).getByRole('button')).toBeFocused();await openDraft(p);await expect(title(p)).toHaveValue('Retomada dos números com a turma');await expect(priority.getByRole('combobox')).toHaveValue('4');
    check('Validação e edição de grupos/campos, saída recusada, escrita única, bloqueio durante envio e persistência ao reabrir');
    const other=await c.newPage();await go(other);await openDraft(other);await title(other).fill('Alterações da segunda aba preservadas');
    await title(p).fill('Versão salva na primeira aba');await save(p).click();await expect(save(p)).toBeEnabled();await save(other).click();await expect(other.getByRole('dialog').getByRole('alert')).toContainText('A prévia precisa ser refeita');await expect(title(other)).toHaveValue('Alterações da segunda aba preservadas');await expect(other.getByRole('dialog').getByRole('alert')).toBeFocused();
    other.once('dialog',d=>d.dismiss());await other.getByRole('button',{name:'Recarregar prévia'}).click();await expect(title(other)).toHaveValue('Alterações da segunda aba preservadas');
    other.once('dialog',d=>d.accept());await other.getByRole('button',{name:'Recarregar prévia'}).click();await expect(title(other)).toHaveValue('Versão salva na primeira aba');await other.close();
    await title(p).fill('Rascunho salvo com resposta perdida');await p.route(writeUrl,async r=>{if(r.request().method()!=='PUT')return r.continue();const response=await r.fetch();assert.equal(response.status(),200);await r.fulfill({status:503,contentType:'application/json',body:'{}'});});
    await save(p).click();await expect(p.getByRole('dialog').getByRole('alert')).toContainText('verificar se o rascunho foi salvo');await expect(save(p)).toBeDisabled();await capture(p,'uncertain-draft');await p.unroute(writeUrl);p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'Recarregar prévia'}).click();await expect(title(p)).toHaveValue('Rascunho salvo com resposta perdida');
    await confirm(p).check();await activate(p).click();await expect(p.getByRole('dialog').getByRole('heading',{name:'Organizar as aulas de apoio',exact:true})).toBeVisible();await expect(title(p)).toHaveCount(0);await p.getByRole('dialog').locator('summary').first().click();await expect(p.getByRole('dialog').getByText(/^Em acompanhamento ·/)).toBeVisible();await capture(p,'active-plan');
    assert.equal((await api(assignmentPath+'/results/recovery-plans/'+draft.id)).plan.status,'active');await p.keyboard.press('Escape');await expect(row(p).getByRole('button',{name:'Organizar aulas'})).toBeFocused();
    check('Conflito entre abas, descarte somente confirmado, resposta perdida após commit recuperada e ativação explícita imutável');
    const fresh=await createDiagnostic();await go(p,`/banco-questoes/devolutivas?turma=${classPublicId}&avaliacao=${fresh.draftAssessmentId}`);await p.getByRole('button',{name:'Ver correções',exact:true}).click();await p.getByRole('button',{name:'Revisar recomposição',exact:true}).click();await expect(title(p)).toBeVisible();
    await title(p).fill('Novo apoio criado pela interface');p.once('dialog',d=>d.dismiss());await p.keyboard.press('Escape');await expect(title(p)).toHaveValue('Novo apoio criado pela interface');
    await p.getByRole('checkbox',{name:/^Conferi as prioridades/}).check();const createUrl=baseUrl+'/api'+fresh.assignmentPath+'/results/recovery-plans';const keys=[];
    const before=db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='create_learning_recovery_plan'").pluck().get();
    await p.route(createUrl,async r=>{keys.push(r.request().headers()['idempotency-key']);const response=await r.fetch();assert.equal(response.status(),201);await r.fulfill({status:503,contentType:'application/json',body:'{}'});});
    await p.getByRole('button',{name:'Criar plano em rascunho',exact:true}).click();await expect(p.getByRole('dialog').getByRole('alert')).toContainText('Confirmação aguardando verificação');await expect(title(p)).toBeDisabled();await capture(p,'uncertain-create');await p.unroute(createUrl);p.on('request',r=>{if(r.method()==='POST'&&r.url()===createUrl)keys.push(r.headers()['idempotency-key']);});
    await p.getByRole('button',{name:'Verificar confirmação'}).click();await expect(p.getByRole('heading',{name:'Agora revise e ative o plano'})).toBeVisible();await capture(p,'created-draft');assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='create_learning_recovery_plan'").pluck().get(),before+1);
    await p.getByRole('button',{name:'Revisar rascunho agora'}).click();await expect(title(p)).toHaveValue('Novo apoio criado pela interface');await expect(activate(p)).toBeDisabled();await p.getByRole('button',{name:'Voltar aos resultados',exact:true}).click();await expect(p.getByRole('button',{name:'Revisar recomposição'})).toBeVisible();await p.keyboard.press('Escape');
    check('Criação pela tela de resultados: saída protegida, repetição com a mesma chave após commit, uma auditoria e revisão final ainda obrigatória');
    await go(p);await p.getByRole('button',{name:'Ver histórico',exact:true}).first().click();await expect(p.getByRole('dialog').getByRole('heading',{name:'Ciclo concluído',exact:true})).toBeVisible();await expect(title(p)).toHaveCount(0);await p.getByRole('heading',{name:'Prioridades pedagógicas',exact:true}).scrollIntoViewIfNeeded();await capture(p,'history-priorities');await p.getByRole('heading',{name:'Grupos temporários de apoio',exact:true}).scrollIntoViewIfNeeded();await capture(p,'history-groups');await p.keyboard.press('Escape');
    assert.deepEqual(report.pageErrors,[]);check('Histórico concluído com prioridades/grupos preservados, sem campos de revisão nem erros JavaScript');
    report.status='captured';record();return report;
  } finally {for(const c of contexts)await c.close().catch(()=>{});await browser.close();}
}
module.exports={runRecoveryLayoutBrowser};
