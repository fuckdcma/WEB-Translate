import {allowMethods,envState,geminiPlatform,readAgentRun,readAgentRuns,readProjectStatus,readProjects,send,writeAgentRun} from './_shared.js';

const agent='antigravity-preview-05-2026';
const runnerModel='gemini-3.5-flash-lite';
const terminalStates=new Set(['completed','failed','cancelled']);
const validId=value=>/^[a-zA-Z0-9._-]+$/.test(String(value||''));
const now=()=>new Date().toISOString();
function resumeSchedule(){const start=(new Date().getUTCMinutes()+12)%60;return [0,15,30,45].map(offset=>(start+offset)%60).sort((a,b)=>a-b).join(',')+' * * * *'}

function publicOrigin(req){
  const configured=process.env.PUBLIC_SITE_URL||process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if(configured)return configured.startsWith('http')?configured:`https://${configured}`;
  const host=req.headers['x-forwarded-host']||req.headers.host;
  return `https://${host}`;
}

function runPrompt(project,runId){
  const repo=process.env.HF_DATASET_REPO;
  const env=`PROJECT_ID=${project.id} RUN_ID=${runId} WORKER_COUNT=1 WORKER_INDEX=0 HF_DATASET_REPO=${repo} HF_TOKEN=proxy-managed GEMINI_API_KEY=proxy-managed`;
  return `You are the background localization runner for project ${project.id}. Work only in /workspace/repo. Resume from the checkpoints already stored in Hugging Face; never restart completed work. Run these commands one at a time with code_execution and wait for each to finish:\n1. corepack pnpm install --frozen-lockfile\n2. ${env} node scripts/coordinate-project.mjs\n3. ${env} node scripts/analyze-project.mjs\n4. ${env} node scripts/translate-worker.mjs\n5. ${env} node scripts/review-project.mjs\nIf a script reports quota pause, checkpoint pause, or no work, stop successfully so the next scheduled execution can resume. Do not edit source code and do not expose credentials. Source file: ${project.fileName||'unknown'}.`;
}

function hookConfig(origin,runId,projectId){
  return JSON.stringify({'storyforge-progress':{enabled:true,post_tool_execution:[{matcher:'code_execution|read_file|write_file',hooks:[{type:'http',url:`${origin}/api/agent-hook`,headers:{'X-Agent-Run':runId,'X-Project-Id':projectId},timeout:10}]}]}},null,2);
}

function environment(req,project,runId){
  const origin=publicOrigin(req);
  const host=new URL(origin).host;
  return {type:'remote',sources:[
    {type:'repository',source:`https://github.com/${process.env.GITHUB_OWNER||'fuckdcma'}/${process.env.GITHUB_REPO||'WEB-Translate'}`,target:'/workspace/repo'},
    {type:'inline',target:'.agents/hooks.json',content:hookConfig(origin,runId,project.id)}
  ],network:{allowlist:[
    {domain:host,transform:{Authorization:`Bearer ${process.env.AGENT_HOOK_SECRET||process.env.QUOTA_MONITOR_INGEST_SECRET}`}},
    {domain:'huggingface.co',transform:{Authorization:`Bearer ${process.env.HF_TOKEN}`}},
    {domain:'*.huggingface.co',transform:{Authorization:`Bearer ${process.env.HF_TOKEN}`}},
    {domain:'generativelanguage.googleapis.com',transform:{'x-goog-api-key':process.env.GEMINI_API_KEY}},
    {domain:'*'}
  ]}};
}

async function stageFromProject(run){
  const [dispatch,coordinator,analysis,worker,review]=await Promise.all([
    readProjectStatus(run.projectId,'dispatch'),readProjectStatus(run.projectId,'coordinator'),readProjectStatus(run.projectId,'analysis'),readProjectStatus(run.projectId,'worker-0'),readProjectStatus(run.projectId,'review')
  ]);
  if(review?.status==='completed')return {stage:'completed',status:'completed',detail:'Đã dịch và kiểm tra hoàn tất'};
  if(worker?.status==='completed')return {stage:'reviewing',status:'in_progress',detail:'Đang kiểm tra bản dịch cuối'};
  if(worker?.status==='running')return {stage:'translating',status:'in_progress',detail:`Đang dịch ${Number(worker.processedRows||0).toLocaleString('vi-VN')} dòng`};
  if(worker?.status==='paused')return {stage:'waiting_quota',status:'queued',detail:'Đã lưu checkpoint · chờ lượt tiếp theo'};
  if(analysis?.status==='completed')return {stage:'queued_translation',status:'in_progress',detail:'Đã phân loại · chuẩn bị dịch'};
  if(coordinator?.status==='completed')return {stage:'analyzing',status:'in_progress',detail:'Đang nhận dạng nội dung'};
  if(dispatch||coordinator)return {stage:'coordinating',status:'in_progress',detail:'Đang phân công tác vụ'};
  return {};
}

async function refresh(run){
  if(terminalStates.has(run.status))return run;
  const age=Date.now()-new Date(run.updatedAt||run.createdAt||0).getTime();
  if(Number.isFinite(age)&&age<45_000)return run;
  let next={...run};
  if(run.triggerId)try{
    const trigger=await geminiPlatform(`/triggers/${encodeURIComponent(run.triggerId)}`);
    next.triggerStatus=trigger.status||next.triggerStatus;
    next.nextRunAt=trigger.next_run_time||trigger.nextRunTime||next.nextRunAt;
    next.interactionId=trigger.previous_interaction_id||trigger.previousInteractionId||next.interactionId;
  }catch(error){next.syncError=error.message}
  if(next.interactionId&&!terminalStates.has(next.status))try{
    const interaction=await geminiPlatform(`/interactions/${encodeURIComponent(next.interactionId)}`);
    const state=interaction.status||interaction.state;
    if(state==='completed'||state==='incomplete')next.status='queued';
    else if(['failed','cancelled'].includes(state))next.status=state;
    else if(state)next.status=state==='pending'?'queued':'in_progress';
    next.agentStatus=state||next.agentStatus;
  }catch(error){next.syncError=error.message}
  const progress=await stageFromProject(next);
  next={...next,...progress};
  if(next.status==='completed'&&next.triggerId&&next.triggerStatus==='active')try{
    await geminiPlatform(`/triggers/${encodeURIComponent(next.triggerId)}`,{method:'PATCH',body:JSON.stringify({status:'paused'})});next.triggerStatus='paused';
  }catch(error){next.syncError=error.message}
  const tracked=['status','stage','detail','nextRunAt','interactionId','triggerStatus','agentStatus','syncError'];
  const changed=tracked.some(key=>next[key]!==run[key]);
  if(changed){next.updatedAt=now();await writeAgentRun(next);return next}
  return run;
}

async function createRun(req,project){
  const runId=`agent-${Date.now()}-${project.id}`;
  const createdAt=now();
  let run={id:runId,projectId:project.id,name:project.name,sourceFile:project.fileName||'',provider:'google-agent-hooks',status:'queued',stage:'preparing',detail:'Đang tạo môi trường xử lý',createdAt,updatedAt:createdAt,events:[]};
  await writeAgentRun(run,{addToIndex:true});
  const interactionTemplate={agent,input:[{type:'text',text:runPrompt(project,runId)}],tools:[{type:'code_execution'}],environment:environment(req,project,runId),agent_config:{type:'antigravity',model:runnerModel,max_total_tokens:30000}};
  let trigger;
  try{trigger=await geminiPlatform('/triggers',{method:'POST',body:JSON.stringify({display_name:`StoryForge · ${project.name}`.slice(0,64),schedule:resumeSchedule(),time_zone:'UTC',max_consecutive_failures:3,execution_timeout_seconds:600,interaction:interactionTemplate})})}
  catch(error){await writeAgentRun({...run,status:'failed',stage:'failed',detail:'Không thể tạo phiên Google Agent',error:error.message,updatedAt:now()});throw error}
  run={...run,triggerId:trigger.id||trigger.name,triggerStatus:trigger.status||'active',nextRunAt:trigger.next_run_time||trigger.nextRunTime,detail:'Đã xếp lịch · đang khởi động',updatedAt:now()};
  await writeAgentRun(run);
  try{
    const interaction=await geminiPlatform('/interactions',{method:'POST',body:JSON.stringify({...interactionTemplate,background:true})});
    run={...run,interactionId:interaction.id,status:'in_progress',stage:'starting',detail:'Google Agent đang mở tệp dự án',updatedAt:now()};
  }catch(error){run={...run,detail:'Đã xếp lịch tự động · sẽ chạy ở lượt kế tiếp',warning:error.message,updatedAt:now()}}
  await writeAgentRun(run);
  return run;
}

async function probe(req){
  const runId=`agent-hook-check-${Date.now()}`;const createdAt=now();const project={id:'system-hook-check'};const origin=publicOrigin(req);const host=new URL(origin).host;
  let run={id:runId,projectId:project.id,name:'Kiểm tra Google Agent Hooks',sourceFile:'system-check',currentFile:'system-check',probe:true,provider:'google-agent-hooks',status:'queued',stage:'preparing',detail:'Đang kiểm tra Hook trực tiếp',createdAt,updatedAt:createdAt,events:[]};
  await writeAgentRun(run,{addToIndex:true});
  const environment={type:'remote',sources:[{type:'inline',target:'.agents/hooks.json',content:hookConfig(origin,runId,project.id)}],network:{allowlist:[{domain:host,transform:{Authorization:`Bearer ${process.env.AGENT_HOOK_SECRET||process.env.QUOTA_MONITOR_INGEST_SECRET}`}}]}};
  try{const interaction=await geminiPlatform('/interactions',{method:'POST',body:JSON.stringify({agent,input:[{type:'text',text:'Use code_execution exactly once to run `printf AGENT_HOOK_READY`, then finish.'}],tools:[{type:'code_execution'}],environment,background:true,agent_config:{type:'antigravity',model:runnerModel,max_total_tokens:5000}})});run={...run,interactionId:interaction.id,status:'in_progress',stage:'starting',detail:'Đang chờ sự kiện Hook từ Google',updatedAt:now()};await writeAgentRun(run);return {ok:true,run}}
  catch(error){run={...run,status:'failed',stage:'failed',detail:'Kiểm tra Hook thất bại',error:error.message,updatedAt:now()};await writeAgentRun(run);throw error}
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST']))return;
  try{
    if(req.method==='GET'){
      const stored=await readAgentRuns(req.query?.limit||12);
      const runs=[];for(const item of stored)runs.push(await refresh(item));
      return send(res,200,{runs});
    }
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    if(body.action==='probe')return send(res,200,await probe(req));
    if(body.action==='cancel'){
      const run=await readAgentRun(body.runId);if(!run)return send(res,404,{error:'Không tìm thấy phiên chạy'});
      if(run.interactionId)await geminiPlatform(`/interactions/${encodeURIComponent(run.interactionId)}:cancel`,{method:'POST',body:'{}'});
      if(run.triggerId)await geminiPlatform(`/triggers/${encodeURIComponent(run.triggerId)}`,{method:'PATCH',body:JSON.stringify({status:'paused'})});
      const cancelled={...run,status:'cancelled',stage:'cancelled',detail:'Đã dừng',triggerStatus:run.triggerId?'paused':run.triggerStatus,updatedAt:now()};await writeAgentRun(cancelled);return send(res,200,{run:cancelled});
    }
    if(!envState().agentHooks)return send(res,400,{error:'Google Agent Hooks chưa được cấu hình đầy đủ trên Vercel'});
    if(!validId(body.projectId))return send(res,400,{error:'Mã dự án không hợp lệ'});
    const project=(await readProjects()).find(item=>item.id===body.projectId);if(!project)return send(res,404,{error:'Không tìm thấy dự án'});
    const active=(await readAgentRuns(20)).find(item=>item.projectId===project.id&&!terminalStates.has(item.status));
    if(active)return send(res,200,{run:active,message:'Dự án đang được Google Agent xử lý tự động'});
    const run=await createRun(req,project);return send(res,201,{run,message:'Google Agent đã bắt đầu xử lý tự động'});
  }catch(error){send(res,500,{error:error.message||'Không thể điều khiển Google Agent'})}
}
