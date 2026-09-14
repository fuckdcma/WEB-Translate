const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const titles={overview:'Tổng quan',projects:'Dự án',api:'Tình trạng API',models:'Model Gemini',versions:'Quy trình dịch'};
const toast=$('#toast');
let projects=[];
let runs=[];
let activeFilter='all';
let toastTimer;
let trackerTimer;
let trackedProjectId=null;
let editState=null;
let modelState={selected:'',models:[]};

function showToast(message,isError=false){clearTimeout(toastTimer);toast.textContent=message;toast.classList.toggle('error',isError);toast.classList.add('show');toastTimer=setTimeout(()=>toast.classList.remove('show'),3200)}
async function request(url,options){const response=await fetch(url,{headers:{'Content-Type':'application/json'},...options});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`Yêu cầu thất bại (${response.status})`);return data}
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
function activateTab(id){$$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.tab===id));$$('.tab-page').forEach(x=>x.classList.toggle('active',x.id===id));$('#pageTitle').textContent=titles[id];history.replaceState(null,'',`#${id}`);window.scrollTo({top:0,behavior:'smooth'});if(id==='api')loadIntegrations();if(id==='models')loadModels()}
$$('[data-tab]').forEach(button=>button.addEventListener('click',()=>activateTab(button.dataset.tab)));
$$('[data-tab-jump]').forEach(button=>button.addEventListener('click',()=>activateTab(button.dataset.tabJump)));
const startTab=location.hash.slice(1);if(titles[startTab])activateTab(startTab);

function initials(name){return name.split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase()||'PR'}
function projectMarkup(project){
  const progress=Math.max(0,Math.min(100,Number(project.progress)||0));
  const done=project.status==='done';
  const paused=project.status==='paused';
  const failed=project.status==='failed';
  const label=done?'Hoàn thành':paused?'Đã lưu · Tạm dừng':failed?'Cần kiểm tra':'Đang thực hiện';
  return `<article class="project-row" data-status="${project.status||'working'}" data-name="${escapeHtml(project.name)}"><div class="project-symbol violet">${initials(project.name)}</div><div class="project-name"><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.sourceLanguage)} → ${escapeHtml(project.targetLanguage)} · ${escapeHtml(project.fileName||'')}</span></div><div class="row-progress"><span>${Number(project.translatedRows||0).toLocaleString('vi-VN')} / ${Number(project.totalRows||0).toLocaleString('vi-VN')} dòng</span><div><i style="width:${progress}%"></i></div></div><span class="badge ${done?'done':paused?'paused':failed?'failed':'working'}">${progress}% · ${label}</span><div class="project-actions"><button class="track-action" data-track-project="${project.id}">Theo dõi</button><button class="download-action" data-download-project="${project.id}">Tải xuống</button><button class="edit-action" data-edit-project="${project.id}">Chỉnh sửa</button><button class="run-action" data-project-id="${project.id}">${done?'Chạy lại':paused?'Tiếp tục':'Chạy dịch'}</button><button class="delete-action" data-delete-project="${project.id}" aria-label="Xoá ${escapeHtml(project.name)}">Xoá</button></div></article>`;
}
function filteredProjects(){const query=$('#projectSearch').value.trim().toLowerCase();return projects.filter(project=>(activeFilter==='all'||activeFilter==='working'&&project.status!=='done'||project.status===activeFilter)&&project.name.toLowerCase().includes(query))}
function renderProjects(){
  const list=$('#projectList');
  const visible=filteredProjects();
  $('#projectNavCount').textContent=projects.length;
  $('#allCount').textContent=projects.length;
  $('#workingCount').textContent=projects.filter(x=>x.status!=='done').length;
  $('#doneCount').textContent=projects.filter(x=>x.status==='done').length;
  list.innerHTML=visible.length?visible.map(projectMarkup).join(''):'<div class="panel empty-state"><span>◇</span><strong>Không có dự án phù hợp</strong><p>Tạo dự án mới từ tệp TSV hoặc CSV.</p><button class="primary" data-open-create>Tạo dự án</button></div>';
  bindDynamicActions();
  renderOverview();
}
function renderOverview(){
  const totalRows=projects.reduce((sum,p)=>sum+Number(p.totalRows||0),0);
  const translated=projects.reduce((sum,p)=>sum+Number(p.translatedRows||0),0);
  const progress=totalRows?Math.round(translated/totalRows*100):0;
  $('#overallProgress').textContent=`${progress}%`;$('#overallBar').style.width=`${progress}%`;$('#overallCaption').textContent=projects.length?`${translated.toLocaleString('vi-VN')} / ${totalRows.toLocaleString('vi-VN')} dòng`:'Chưa có dự án';
  const structure=projects.length?Math.round(projects.filter(project=>project.fileName&&project.totalRows>=0).length/projects.length*100):0;
  $('#structureProgress').textContent=`${structure}%`;$('#structureBar').style.width=`${structure}%`;$('#structureCaption').textContent=projects.length?`${projects.filter(project=>project.fileName).length}/${projects.length} tệp hợp lệ`:'Chưa có dữ liệu kiểm tra';
  const latest=projects[0];$('#currentProjectEmpty').hidden=Boolean(latest);$('#currentProjectData').hidden=!latest;
  if(latest){$('#currentProjectName').textContent=latest.name;$('#currentBadge').textContent=latest.status==='done'?'Hoàn thành':'Đang thực hiện';$('#currentBadge').className=`badge ${latest.status==='done'?'done':'working'}`;$('#currentProgress').textContent=`${latest.progress||0}%`;$('#currentRing').style.strokeDasharray=`${latest.progress||0} 100`;$('#currentRows').textContent=`${Number(latest.translatedRows||0).toLocaleString('vi-VN')} / ${Number(latest.totalRows||0).toLocaleString('vi-VN')} dòng`}
  const done=projects.filter(x=>x.status==='done');$('#completedGrid').innerHTML=done.length?done.map(p=>`<div class="completed-card"><div class="project-symbol teal">${initials(p.name)}</div><div><strong>${escapeHtml(p.name)}</strong><p>${Number(p.totalRows||0).toLocaleString('vi-VN')} dòng · ${escapeHtml(p.targetLanguage)}</p></div><div class="completed-actions"><button data-download-project="${p.id}">Tải xuống</button><button data-edit-project="${p.id}">Chỉnh sửa</button></div></div>`).join(''):'<div class="empty-state compact-empty"><span>◇</span><p>Chưa có dự án hoàn thiện.</p></div>';
  bindFileActions();
}
function bindFileActions(){$$('[data-download-project]').forEach(button=>button.onclick=()=>downloadProject(button.dataset.downloadProject,button));$$('[data-edit-project]').forEach(button=>button.onclick=()=>openEditor(button.dataset.editProject))}
function bindDynamicActions(){$$('[data-open-create]').forEach(button=>button.onclick=openCreateDialog);$$('.run-action').forEach(button=>button.onclick=()=>runWorkflow(button.dataset.projectId,button));$$('[data-track-project]').forEach(button=>button.onclick=()=>openProjectTracker(button.dataset.trackProject));$$('[data-delete-project]').forEach(button=>button.onclick=()=>deleteProject(button.dataset.deleteProject,button));bindFileActions()}

function parseDelimited(content,delimiter){const rows=[];let row=[],value='',quoted=false;for(let index=0;index<content.length;index+=1){const char=content[index];if(char==='"'){if(quoted&&content[index+1]==='"'){value+='"';index+=1}else quoted=!quoted}else if(char===delimiter&&!quoted){row.push(value);value=''}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&content[index+1]==='\n')index+=1;row.push(value);if(row.some(cell=>cell!==''))rows.push(row);row=[];value=''}else value+=char}row.push(value);if(row.some(cell=>cell!==''))rows.push(row);return rows}
function serializeDelimited(rows,delimiter){const encode=value=>{const text=String(value??'');return text.includes(delimiter)||/["\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text};return rows.map(row=>row.map(encode).join(delimiter)).join('\n')}
function editorColumns(rows){const header=rows[0]||[];const target=header.findIndex(column=>/^(vietnamese|vi|translation)$/i.test(column.trim()));const source=header.findIndex((column,index)=>index!==target&&/^(languages?|source|english|text|original)$/i.test(column.trim()));return{key:0,target:target>=0?target:Math.max(0,header.length-1),source:source>=0?source:Math.min(1,Math.max(0,header.length-1))}}
function triggerDownload(content,fileName,mime){const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([content],{type:mime}));link.download=fileName;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),1000)}
async function getProjectFile(projectId){return request(`/api/project-file?id=${encodeURIComponent(projectId)}`)}
async function downloadProject(projectId,button){const oldText=button?.textContent;if(button){button.disabled=true;button.textContent='Đang chuẩn bị...'}try{const data=await getProjectFile(projectId);triggerDownload(data.content,data.fileName,data.delimiter===','?'text/csv;charset=utf-8':'text/tab-separated-values;charset=utf-8');showToast(`Đã tải ${data.fileName}`)}catch(error){showToast(error.message,true)}finally{if(button){button.disabled=false;button.textContent=oldText}}}

function filteredEditorRows(){if(!editState)return[];const query=$('#editSearch').value.trim().toLowerCase();const {key,source,target}=editState.columns;return editState.rows.slice(1).map((row,index)=>({row,index:index+1})).filter(item=>!query||[item.row[key],item.row[source],item.row[target]].some(value=>String(value||'').toLowerCase().includes(query)))}
function renderEditor(){if(!editState)return;const filtered=filteredEditorRows();const pageSize=50;const pages=Math.max(1,Math.ceil(filtered.length/pageSize));editState.page=Math.min(Math.max(1,editState.page),pages);const shown=filtered.slice((editState.page-1)*pageSize,editState.page*pageSize);const {key,source,target}=editState.columns;$('#editRows').innerHTML=shown.length?shown.map(item=>`<div class="editor-row"><code title="${escapeHtml(item.row[key]||'')}">${escapeHtml(item.row[key]||`Dòng ${item.index}`)}</code><p>${escapeHtml(item.row[source]||'')}</p><textarea data-edit-row="${item.index}" aria-label="Bản dịch dòng ${item.index}" placeholder="Chưa có bản dịch">${escapeHtml(item.row[target]||'')}</textarea></div>`).join(''):'<div class="editor-empty">Không có dòng phù hợp</div>';$('#editCount').textContent=`${filtered.length.toLocaleString('vi-VN')} dòng · Trang ${editState.page}/${pages}`;$('#editPrev').disabled=editState.page<=1;$('#editNext').disabled=editState.page>=pages;$$('[data-edit-row]').forEach(input=>input.addEventListener('input',()=>{editState.rows[Number(input.dataset.editRow)][target]=input.value;editState.dirty=true;$('#saveEdit').disabled=false}))}
async function openEditor(projectId){const project=projects.find(item=>item.id===projectId);if(!project)return;$('#editTitle').textContent=project.name;$('#editorLoading').hidden=false;$('#editorContent').hidden=true;$('#editSearch').value='';$('#saveEdit').disabled=true;$('#editDialog').showModal();try{const data=await getProjectFile(projectId);if(!$('#editDialog').open)return;const rows=parseDelimited(data.content,data.delimiter);editState={projectId,project,fileName:data.fileName,delimiter:data.delimiter,rows,columns:editorColumns(rows),page:1,dirty:false};$('#editorLoading').hidden=true;$('#editorContent').hidden=false;renderEditor()}catch(error){editState=null;$('#editDialog').close();showToast(error.message,true)}}
function closeEditor(){editState=null;$('#editDialog').close()}
async function saveEditor(){if(!editState)return;const button=$('#saveEdit');button.disabled=true;button.textContent='Đang lưu...';try{const content=serializeDelimited(editState.rows,editState.delimiter);const result=await request('/api/project-file',{method:'PUT',body:JSON.stringify({id:editState.projectId,content})});editState.dirty=false;const project=projects.find(item=>item.id===editState.projectId);if(project)project.translatedRows=result.translatedRows;showToast(result.message);await hydrateProjectProgress();closeEditor()}catch(error){showToast(error.message,true);button.disabled=false}finally{button.textContent='Lưu thay đổi'}}

async function hydrateProjectProgress(){const snapshot=[...projects];const statuses=await Promise.allSettled(snapshot.map(project=>request(`/api/project-status?id=${encodeURIComponent(project.id)}`)));for(let index=0;index<statuses.length;index+=1){if(statuses[index].status!=='fulfilled')continue;const projectIndex=projects.findIndex(project=>project.id===snapshot[index].id);if(projectIndex>=0)projects[projectIndex]=statuses[index].value.project}renderProjects()}
async function loadProjects(){try{const data=await request('/api/projects');projects=data.projects||[];renderProjects();$('#systemUpdated').textContent='Đang khôi phục tiến độ';await hydrateProjectProgress();$('#systemUpdated').textContent='Vừa đồng bộ'}catch(error){projects=[];renderProjects();showToast(error.message,true)}}
async function deleteProject(projectId,button){const project=projects.find(item=>item.id===projectId);if(!project)return;if(!window.confirm(`Xoá dự án "${project.name}"? Tệp nguồn, bản dịch và tiến độ đã lưu cũng sẽ bị xoá.`))return;button.disabled=true;button.textContent='Đang xoá...';try{await request('/api/projects',{method:'DELETE',body:JSON.stringify({id:projectId})});projects=projects.filter(item=>item.id!==projectId);renderProjects();showToast('Đã xoá dự án và dữ liệu đã lưu')}catch(error){showToast(error.message,true);button.disabled=false;button.textContent='Xoá'}}
async function loadRuns(){const list=$('#runsList');try{const data=await request('/api/github-actions');runs=data.runs||[];const running=runs.filter(x=>x.status==='in_progress').length,queued=runs.filter(x=>x.status==='queued').length;$('#runningCount').textContent=running;$('#queuedCount').textContent=queued;$('#actionCount').textContent=running+queued;list.innerHTML=runs.length?runs.slice(0,4).map(run=>`<div class="timeline-item"><span class="timeline-icon ${run.conclusion==='success'?'success':'process'}">${run.conclusion==='success'?'✓':'↻'}</span><div><strong>${escapeHtml(run.name)}</strong><p>${escapeHtml(run.status)}${run.conclusion?` · ${escapeHtml(run.conclusion)}`:''}</p><small>${new Date(run.createdAt).toLocaleString('vi-VN')}</small></div></div>`).join(''):'<div class="empty-state compact-empty"><span>◇</span><p>Chưa có phiên chạy.</p></div>'}catch(error){$('#actionCount').textContent='—';list.innerHTML=`<div class="empty-state compact-empty"><span>!</span><p>${escapeHtml(error.message)}</p></div>`}}
async function loadIntegrations(){try{const data=await request('/api/integrations');setIntegration('#hfStatus',data.checks.huggingFace);setIntegration('#githubStatus',data.checks.github);setIntegration('#googleStatus',data.checks.googleAI);$('#hfRepo').textContent=data.dataset||'Chưa cấu hình';$('#githubRepo').textContent=data.repository||'Chưa cấu hình';$('#githubWorkflow').textContent=data.workflow||'translate.yml';$('#googleModel').textContent=data.model||'gemini-3.6-flash'}catch(error){showToast(error.message,true)}}
function setIntegration(selector,state){const element=$(selector);element.innerHTML=`<i></i>${state.ok?'Đã kết nối':state.configured?'Lỗi kết nối':'Chưa cấu hình'}`;element.classList.toggle('connected',state.ok);element.classList.toggle('failed',state.configured&&!state.ok);if(state.error)element.title=state.error}

function tokenLabel(value){const amount=Number(value)||0;if(!amount)return'Không công bố';if(amount>=1_000_000)return`${Math.round(amount/1_000_000)}M tokens`;if(amount>=1_000)return`${Math.round(amount/1_000)}K tokens`;return`${amount} tokens`}
function renderModels(){
  $('#currentModel').textContent=modelState.selected||'Chưa chọn';
  $('#modelCount').textContent=modelState.models.length;
  $('#modelList').innerHTML=modelState.models.length?modelState.models.map(model=>{const selected=model.id===modelState.selected;return `<article class="model-row ${selected?'selected':''}"><div class="model-main"><span class="model-logo">G</span><div><strong>${escapeHtml(model.name)}</strong><code>${escapeHtml(model.id)}</code><small>Đầu vào ${tokenLabel(model.inputTokenLimit)} · Đầu ra ${tokenLabel(model.outputTokenLimit)}</small></div></div><div class="model-speed ${escapeHtml(model.tone)}"><div class="speed-gauge" style="--score:${Math.max(20,Math.min(100,Number(model.score)||70))}"><i></i><b></b></div><span>${escapeHtml(model.speed)}</span></div><button class="${selected?'model-selected':'model-select'}" data-model-id="${escapeHtml(model.id)}" ${selected?'disabled':''}>${selected?'✓ Đang dùng':'Chọn'}</button></article>`}).join(''):'<div class="model-empty"><span>!</span><strong>Không tìm thấy model dịch phù hợp</strong><p>Hãy kiểm tra lại kết nối Google AI Studio.</p></div>';
  $$('[data-model-id]').forEach(button=>button.onclick=()=>chooseModel(button.dataset.modelId,button));
}
async function loadModels(){const list=$('#modelList');list.innerHTML='<div class="model-loading"><i></i><strong>Đang lấy danh sách model từ Google...</strong></div>';try{modelState=await request('/api/models');renderModels()}catch(error){list.innerHTML=`<div class="model-empty"><span>!</span><strong>Không thể tải model</strong><p>${escapeHtml(error.message)}</p></div>`;showToast(error.message,true)}}
async function chooseModel(modelId,button){button.disabled=true;button.textContent='Đang lưu...';try{modelState=await request('/api/models',{method:'PUT',body:JSON.stringify({model:modelId})});renderModels();$('#googleModel').textContent=modelState.selected;showToast(`Đã chọn ${modelState.selected} cho các phiên dịch tiếp theo`)}catch(error){button.disabled=false;button.textContent='Chọn';showToast(error.message,true)}}

const createDialog=$('#createDialog');
const trackerDialog=$('#trackerDialog');
function openCreateDialog(){resetCreationProgress();createDialog.showModal()}
$$('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$('#projectFile').addEventListener('change',event=>{$('#projectFileLabel').textContent=event.target.files[0]?.name||'Chọn tệp TSV hoặc CSV'});
function setCreationStep(id,state){const item=$(`[data-create-step="${id}"]`);item.className=`creation-step ${state}`;item.querySelector('i').textContent=state==='complete'?'✓':state==='error'?'!':item.dataset.createStep==='validate'?'1':item.dataset.createStep==='store'?'2':item.dataset.createStep==='record'?'3':'4'}
function resetCreationProgress(){$('#creationProgress').hidden=true;$('#createFields').hidden=false;for(const item of $$('.creation-step'))item.className='creation-step';$('#cancelCreate').disabled=false}

$('#createForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const file=$('#projectFile').files[0];
  if(!file){showToast('Hãy chọn tệp TSV hoặc CSV',true);return}
  const button=$('#confirmCreate');
  const workers=Math.min(4,Math.max(1,Number($('#workerCount').value)||4));
  button.disabled=true;button.textContent='Đang khởi tạo...';$('#cancelCreate').disabled=true;$('#createFields').hidden=true;$('#creationProgress').hidden=false;setCreationStep('validate','active');
  try{
    if(!/\.(tsv|csv)$/i.test(file.name))throw new Error('Chỉ hỗ trợ tệp TSV hoặc CSV');
    const content=await file.text();
    if(!content.trim()||content.trim().split(/\r?\n/).length<2)throw new Error('Tệp phải có tiêu đề và ít nhất một dòng dữ liệu');
    setCreationStep('validate','complete');setCreationStep('store','active');
    const payload={name:$('#newProjectName').value.trim(),sourceLanguage:$('#sourceLanguage').value,targetLanguage:$('#targetLanguage').value,file:{name:file.name,type:file.type,content}};
    const data=await request('/api/projects',{method:'POST',body:JSON.stringify(payload)});
    setCreationStep('store','complete');setCreationStep('record','complete');setCreationStep('dispatch','active');
    projects.unshift(data.project);renderProjects();
    await runWorkflow(data.project.id,null,workers,false);
    setCreationStep('dispatch','complete');
    await new Promise(resolve=>setTimeout(resolve,450));
    createDialog.close();$('#createForm').reset();$('#projectFileLabel').textContent='Thả hoặc chọn tệp TSV/CSV';resetCreationProgress();showToast('Luồng chính đã bắt đầu phân công tác vụ');openProjectTracker(data.project.id);
  }catch(error){
    const active=$('.creation-step.active');if(active)active.classList.replace('active','error');
    showToast(error.message,true);$('#cancelCreate').disabled=false;
  }finally{button.disabled=false;button.textContent='Tạo dự án thật'}
});

async function runWorkflow(projectId,button,workers=4,openTracker=true){
  if(button){button.disabled=true;button.textContent='Đang chạy...'}
  try{const result=await request('/api/github-actions',{method:'POST',body:JSON.stringify({projectId,workers})});showToast(result.message||'Đã xếp lịch xử lý');await loadRuns();if(openTracker)openProjectTracker(projectId)}catch(error){showToast(error.message,true);throw error}finally{if(button){button.disabled=false;const project=projects.find(item=>item.id===projectId);button.textContent=project?.status==='done'?'Chạy lại':project?.status==='paused'?'Tiếp tục':'Chạy dịch'}}
}

function statusIcon(status){return status==='complete'?'✓':status==='error'?'!':status==='paused'?'Ⅱ':status==='active'?'↻':'·'}
function renderTracker(data){
  $('#trackerTitle').textContent=data.project.name;
  $('#trackerStage').textContent=data.currentStage;
  $('#trackerPercent').textContent=`${data.progress}%`;
  $('#trackerBar').style.width=`${data.progress}%`;
  $('#trackerUpdated').textContent=`Cập nhật lúc ${new Date(data.updatedAt).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  $('#trackerSteps').innerHTML=data.steps.map(item=>`<li class="${item.status}"><i>${statusIcon(item.status)}</i><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span></li>`).join('');
  $('#workerSummary').textContent=data.coordinator&&data.totalTasks?`${Number(data.completedTasks||0)}/${data.totalTasks} tác vụ · ${data.summary.completed}/${data.workers} luồng xong${data.summary.paused?` · ${data.summary.paused} tạm dừng`:''}`:data.workers?`${data.summary.completed}/${data.workers} hoàn tất${data.summary.paused?` · ${data.summary.paused} tạm dừng`:''}`:'Đang chờ';
  $('#workerGrid').innerHTML=data.shards.length?data.shards.map(item=>`<div class="worker-chip ${item.status}" title="${escapeHtml(item.error||item.message||'')}"><i>${item.status==='completed'?'✓':item.status==='failed'?'!':item.status==='paused'?'Ⅱ':item.status==='running'?'↻':'·'}</i><span>Luồng ${Number(item.index)+1}<small>${item.totalTasks?`${Number(item.completedTasks||0)}/${item.totalTasks} tác vụ`:item.status==='completed'?'Hoàn tất':item.status==='failed'?'Lỗi':item.status==='paused'?`Đã lưu ${Number(item.processedRows||0)} dòng`:item.status==='running'?`${Number(item.processedRows||0)} dòng`:'Chờ'}</small></span></div>`).join(''):'<span class="worker-empty">Chưa có luồng xử lý</span>';
  const review=$('#reviewResult');
  review.hidden=!data.review;
  if(data.review)review.innerHTML=`<strong>Kết quả kiểm tra</strong><span>${Number(data.review.checkedRows||0).toLocaleString('vi-VN')} dòng · ${Number(data.review.issueCount||0).toLocaleString('vi-VN')} điểm cần xem lại</span>`;
  const index=projects.findIndex(project=>project.id===data.project.id);if(index>=0){projects[index]=data.project;renderProjects()}
  $('#trackerError').classList.toggle('paused',data.state==='paused');
  $('#trackerError').hidden=data.state!=='paused';
  if(data.state==='paused')$('#trackerError').textContent='Tiến độ đã được lưu. Nhấn “Tiếp tục” sau khi giới hạn Google được làm mới.';
  if(data.progress===100||data.state==='paused'){clearInterval(trackerTimer);trackerTimer=null}
}
async function refreshProjectTracker(){
  if(!trackedProjectId)return;
  try{const data=await request(`/api/project-status?id=${encodeURIComponent(trackedProjectId)}`);renderTracker(data)}catch(error){$('#trackerError').classList.remove('paused');$('#trackerError').hidden=false;$('#trackerError').textContent=error.message}
}
function openProjectTracker(projectId){
  trackedProjectId=projectId;clearInterval(trackerTimer);$('#trackerStage').textContent='Đang tải trạng thái...';$('#trackerPercent').textContent='0%';$('#trackerBar').style.width='0%';$('#trackerSteps').innerHTML='<li class="active"><i>↻</i><span><strong>Đang đồng bộ</strong><small>Vui lòng chờ trong giây lát</small></span></li>';$('#workerGrid').innerHTML='<span class="worker-empty">Đang tải...</span>';$('#trackerError').hidden=true;
  if(!trackerDialog.open)trackerDialog.showModal();
  refreshProjectTracker();trackerTimer=setInterval(refreshProjectTracker,5000);
}
function closeProjectTracker(){clearInterval(trackerTimer);trackerTimer=null;trackedProjectId=null;trackerDialog.close()}
$('#closeTracker').addEventListener('click',closeProjectTracker);$('#doneTracker').addEventListener('click',closeProjectTracker);$('#refreshTracker').addEventListener('click',refreshProjectTracker);trackerDialog.addEventListener('close',()=>{clearInterval(trackerTimer);trackerTimer=null;trackedProjectId=null});

$('#closeEditor').addEventListener('click',closeEditor);$('#cancelEdit').addEventListener('click',closeEditor);$('#saveEdit').addEventListener('click',saveEditor);$('#editSearch').addEventListener('input',()=>{if(editState){editState.page=1;renderEditor()}});$('#editPrev').addEventListener('click',()=>{if(editState){editState.page-=1;renderEditor()}});$('#editNext').addEventListener('click',()=>{if(editState){editState.page+=1;renderEditor()}});$('#downloadEdited').addEventListener('click',()=>{if(editState)triggerDownload(serializeDelimited(editState.rows,editState.delimiter),editState.fileName,editState.delimiter===','?'text/csv;charset=utf-8':'text/tab-separated-values;charset=utf-8')});

$$('.filter').forEach(button=>button.addEventListener('click',()=>{$$('.filter').forEach(x=>x.classList.remove('active'));button.classList.add('active');activeFilter=button.dataset.filter;renderProjects()}));
$('#projectSearch').addEventListener('input',renderProjects);
$('#refreshRuns').addEventListener('click',loadRuns);
$('#refreshIntegrations').addEventListener('click',loadIntegrations);
$('#refreshModels').addEventListener('click',loadModels);
$$('.restore').forEach(button=>button.addEventListener('click',()=>showToast('Khôi phục phiên bản được quản lý bởi GitHub')));

bindDynamicActions();loadProjects();loadRuns();
