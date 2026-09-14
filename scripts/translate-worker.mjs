import {createHash} from 'node:crypto';
import {GooglePauseError,requestGoogle,sleep} from './google-api.mjs';
import {jsonFile,readJson,readText,StoragePauseError,uploadWithRetry} from './hf-pipeline.mjs';
import {detectColumns,parseDelimited} from './tabular.mjs';

const required=['PROJECT_ID','RUN_ID','WORKER_INDEX','WORKER_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const projectId=process.env.PROJECT_ID;const runId=process.env.RUN_ID;const workerIndex=Number(process.env.WORKER_INDEX);const workerCount=Math.min(4,Math.max(1,Number(process.env.WORKER_COUNT)||1));
const statusPath=`status/${projectId}/worker-${workerIndex}.json`;const baseSpacing=Math.max(12_500,Number(process.env.GEMINI_REQUEST_SPACING_MS)||13_000);

function workerStatus(status,extra={}){return jsonFile(statusPath,{runId,index:workerIndex,status,updatedAt:new Date().toISOString(),...extra})}
function taskCheckpoint(task,data){return jsonFile(`checkpoints/${projectId}/tasks/${task.id}.json`,data)}
function parseGooglePayload(payload){const text=payload?.candidates?.[0]?.content?.parts?.[0]?.text||'[]';const parsed=JSON.parse(text);if(!Array.isArray(parsed))throw new Error('Google AI did not return an array');return parsed}

async function main(){
  try{
    const manifest=await readJson(`queues/${projectId}/${runId}/manifest.json`);if(!manifest)throw new Error('Coordinator manifest not found');const googleModel=manifest.model||process.env.GEMINI_MODEL||'gemini-3.6-flash';
    const projects=await readJson('projects.json');const project=projects?.find(item=>item.id===projectId);if(!project)throw new Error(`Project not found: ${projectId}`);
    const source=await readText(`projects/${project.id}/${project.fileName}`);if(source===null)throw new Error('Source file not found');
    const sourceHash=createHash('sha256').update(source).digest('hex');if(sourceHash!==manifest.sourceHash)throw new Error('Source file changed after task assignment');
    const rows=parseDelimited(source,manifest.delimiter);const columns=detectColumns(rows);const dataRows=rows.slice(1);const assigned=manifest.tasks.filter(task=>task.sequence%workerCount===workerIndex);
    const extension=manifest.delimiter===','?'csv':'tsv';const manualContent=await readText(`results/${project.id}/final.${extension}`);const manualRows=manualContent?parseDelimited(manualContent,manifest.delimiter):[];const manualColumns=manualRows.length?detectColumns(manualRows):null;
    let completedTasks=0;let processedRows=0;let apiRequests=0;let recentContext=[];let lastRequestAt=0;let finalStatusWritten=false;
    if(workerIndex>0)await sleep(workerIndex*baseSpacing);

    for(const task of assigned){
      const stored=await readJson(`checkpoints/${projectId}/tasks/${task.id}.json`);const usable=stored?.version===2&&stored.sourceHash===sourceHash&&stored.category===task.category;
      const translations=new Map((usable?stored.translations:[]).map(item=>[Number(item.index),String(item.translation||'')]));
      if(manualColumns)for(const index of task.rowIndexes){const value=manualRows[index+1]?.[manualColumns.target];if(String(value||'').trim())translations.set(index,String(value))}
      const remaining=task.rowIndexes.filter(index=>!String(translations.get(index)||'').trim());

      if(remaining.length){
        const sharedPause=await readJson(`status/${projectId}/quota.json`);if(sharedPause?.runId===runId&&sharedPause?.reason==='daily_quota'){await uploadWithRetry([workerStatus('paused',{currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,apiRequests,pauseReason:'daily_quota',message:'Một luồng đã phát hiện hết lượt Google hôm nay. Luồng này dừng trước khi gửi thêm yêu cầu.',pausedAt:new Date().toISOString()})]);return}
        const elapsed=Date.now()-lastRequestAt;const requiredGap=baseSpacing*workerCount;if(lastRequestAt&&elapsed<requiredGap)await sleep(requiredGap-elapsed);
        const input=remaining.map(index=>({index,key:String(dataRows[index]?.[columns.key]||''),text:String(dataRows[index]?.[columns.source]||'')}));
        const prompt=`You translate one small task in a game localization pipeline. Project: ${project.name}. Category: ${task.category}.
Translate from ${project.sourceLanguage} to ${project.targetLanguage}. Preserve placeholders, tags, variables, proper names and locations exactly. Keep terminology, pronouns, tone and capitalization consistent within this category. Translate only text; key is context.
Recent approved context from this worker: ${JSON.stringify(recentContext.slice(-12))}
Return JSON only: an array with exactly one object per input, fields index and translation. No Markdown.

${JSON.stringify(input)}`;
        let translated=null;
        for(let formatAttempt=1;formatAttempt<=2;formatAttempt+=1){
          try{const response=await requestGoogle({prompt:formatAttempt===1?prompt:`${prompt}\nIMPORTANT: The previous response was incomplete. Return every index exactly once.`,temperature:0.2,label:`Google AI task ${task.id}`,model:googleModel});lastRequestAt=Date.now();apiRequests+=response.attempts;const parsed=parseGooglePayload(response.payload);const byIndex=new Map(parsed.map(item=>[Number(item.index),String(item.translation||'')]));if(input.some(item=>!byIndex.get(item.index)))throw new Error('Incomplete task response');translated=byIndex;break}
          catch(error){
            if(error instanceof GooglePauseError){const pausedAt=new Date().toISOString();const files=[workerStatus('paused',{currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,totalRows:assigned.reduce((sum,item)=>sum+item.rowCount,0),apiRequests,pauseReason:error.reason,message:error.message,pausedAt})];if(error.reason==='daily_quota')files.push(jsonFile(`status/${projectId}/quota.json`,{runId,reason:'daily_quota',message:error.message,pausedAt,workerIndex}));await uploadWithRetry(files);console.warn(error.message);return}
            if(formatAttempt===2){await uploadWithRetry([workerStatus('paused',{currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,apiRequests,pauseReason:'invalid_response',message:'Phản hồi dịch chưa đầy đủ. Tác vụ này sẽ được thử lại ở lần chạy tiếp theo.',pausedAt:new Date().toISOString()})]);console.warn(error.message);return}
            await sleep(baseSpacing*workerCount);
          }
        }
        for(const [index,translation] of translated)translations.set(index,translation);
      }

      const taskTranslations=task.rowIndexes.map(index=>({index,translation:String(translations.get(index)||'')}));const complete=taskTranslations.every(item=>item.translation.trim());
      if(!complete){await uploadWithRetry([workerStatus('paused',{currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,apiRequests,pauseReason:'incomplete_task',message:'Tác vụ chưa đủ bản dịch và sẽ được thử lại.'})]);return}
      completedTasks+=1;processedRows+=task.rowCount;recentContext.push(...task.rowIndexes.slice(-6).map(index=>({source:String(dataRows[index]?.[columns.source]||''),translation:String(translations.get(index)||'')})));recentContext=recentContext.slice(-12);
      const completedAt=new Date().toISOString();const checkpoint={version:2,projectId,sourceHash,taskId:task.id,category:task.category,rowIndexes:task.rowIndexes,translations:taskTranslations,complete:true,apiRequests,completedAt};
      if(!(usable&&stored.complete&&remaining.length===0)){const isLast=completedTasks===assigned.length;await uploadWithRetry([taskCheckpoint(task,checkpoint),workerStatus(isLast?'completed':'running',{currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,totalRows:assigned.reduce((sum,item)=>sum+item.rowCount,0),apiRequests,completedAt:isLast?completedAt:undefined})]);if(isLast)finalStatusWritten=true}
    }
    if(!finalStatusWritten)await uploadWithRetry([workerStatus('completed',{completedTasks,totalTasks:assigned.length,processedRows,totalRows:assigned.reduce((sum,item)=>sum+item.rowCount,0),apiRequests,completedAt:new Date().toISOString()})]);
    console.log(`Worker ${workerIndex} completed ${completedTasks}/${assigned.length} small tasks and saved ${processedRows} rows`);
  }catch(error){if(error instanceof StoragePauseError){console.warn(error.message);return}try{await uploadWithRetry([workerStatus('failed',{error:error.message,failedAt:new Date().toISOString()})])}catch{}throw error}
}

await main();
