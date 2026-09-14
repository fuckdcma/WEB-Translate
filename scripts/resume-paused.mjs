import {randomUUID} from 'node:crypto';
import {jsonFile,readJson,uploadWithRetry} from './hf-pipeline.mjs';

const required=['HF_TOKEN','HF_DATASET_REPO','GITHUB_TOKEN','GITHUB_REPOSITORY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const workflow=process.env.GITHUB_WORKFLOW_FILE||'translate.yml';

const when=value=>{const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:0};
const pacificDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const nextSchedule=(notBefore=Date.now())=>{const date=new Date(Math.max(Date.now(),Number(notBefore)||0));const minute=date.getUTCMinutes();date.setUTCSeconds(0,0);date.setUTCMinutes(minute<7?7:minute<37?37:67);return date.toISOString()};

async function github(path,options={}){const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`,{...options,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'X-GitHub-Api-Version':'2026-03-10','Content-Type':'application/json',...(options.headers||{})}});if(!response.ok)throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0,300)}`);return response.status===204?null:response.json()}

async function isComplete(project){const [manual,report]=await Promise.all([readJson(`status/${project.id}/manual.json`),readJson(`results/${project.id}/review.json`)]);return Number(project.totalRows)>0&&(Number(manual?.translatedRows)>=Number(project.totalRows)||Number(report?.checkedRows)>=Number(project.totalRows))}

async function main(){
  const [projects,queued,running]=await Promise.all([readJson('projects.json'),github(`/actions/workflows/${encodeURIComponent(workflow)}/runs?status=queued&per_page=10`),github(`/actions/workflows/${encodeURIComponent(workflow)}/runs?status=in_progress&per_page=10`)]);
  if((queued?.total_count||0)+(running?.total_count||0)>0){console.log('A translation workflow is already active; auto-resume will check again later.');return}
  for(const project of projects||[]){
    if(await isComplete(project))continue;
    const [dispatch,coordinator,review,quota,automation]=await Promise.all([readJson(`status/${project.id}/dispatch.json`),readJson(`status/${project.id}/coordinator.json`),readJson(`status/${project.id}/review.json`),readJson(`status/${project.id}/quota.json`),readJson(`status/${project.id}/automation.json`)]);
    if(!dispatch?.runId||coordinator?.runId!==dispatch.runId)continue;
    if(Date.now()-when(dispatch.queuedAt)<20*60_000||Date.now()-when(automation?.lastAttemptAt)<20*60_000)continue;
    const dailyPause=quota?.reason==='daily_quota'&&quota?.runId===dispatch.runId;
    if(dailyPause&&pacificDay(quota.pausedAt)===pacificDay(Date.now())){console.log(`${project.name}: waiting for the daily Google limit to reset.`);continue}
    const workerCount=1;
    const runId=randomUUID();
    await github(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,{method:'POST',body:JSON.stringify({ref:process.env.GITHUB_REF_NAME||'main',inputs:{project_id:String(project.id),workers:String(workerCount),run_id:runId}})});
    const now=new Date().toISOString();
    await uploadWithRetry([jsonFile(`status/${project.id}/dispatch.json`,{status:'queued',runId,workers:1,requestedWorkers:1,architecture:'quota-queue-v3',automatic:true,queuedAt:now}),jsonFile(`status/${project.id}/automation.json`,{enabled:true,status:'dispatched',runId,lastAttemptAt:now,nextAttemptAt:nextSchedule(Date.now()+20*60_000),message:'Đã tự động tiếp tục queue từ checkpoint đã lưu.'})]);
    console.log(`Automatically resumed ${project.name} with run ${runId}; previous review status was ${review?.status||'unknown'}.`);
    return;
  }
  console.log('No incomplete project is ready for auto-resume.');
}

await main();
