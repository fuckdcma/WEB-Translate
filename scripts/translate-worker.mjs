import {createHash} from 'node:crypto';
import {GooglePauseError,requestGoogle,sleep} from './google-api.mjs';
import {jsonFile,readJson,readText,StoragePauseError,uploadWithRetry} from './hf-pipeline.mjs';
import {detectColumns,parseDelimited} from './tabular.mjs';

const required=['PROJECT_ID','RUN_ID','WORKER_INDEX','WORKER_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const projectId=process.env.PROJECT_ID;
const runId=process.env.RUN_ID;
const workerIndex=Number(process.env.WORKER_INDEX);
const workerCount=Math.min(4,Math.max(1,Number(process.env.WORKER_COUNT)||1));
const statusPath=`status/${projectId}/worker-${workerIndex}.json`;
const baseSpacing=Math.max(12_500,Number(process.env.GEMINI_REQUEST_SPACING_MS)||13_000);

const emptyUsage=()=>({inputTokens:0,outputTokens:0,totalTokens:0,requests:0});
const normalizeUsage=value=>({inputTokens:Number(value?.inputTokens)||0,outputTokens:Number(value?.outputTokens)||0,totalTokens:Number(value?.totalTokens)||0,requests:Number(value?.requests)||0});
function addUsage(target,value,requestFallback=0){const usage=normalizeUsage(value);target.inputTokens+=usage.inputTokens;target.outputTokens+=usage.outputTokens;target.totalTokens+=usage.totalTokens;target.requests+=usage.requests||requestFallback}
function workerStatus(status,extra={}){return jsonFile(statusPath,{runId,index:workerIndex,status,updatedAt:new Date().toISOString(),...extra})}
function taskCheckpoint(task,data){return jsonFile(`checkpoints/${projectId}/tasks/${task.id}.json`,data)}
function taskPartialCheckpoint(task,data){return jsonFile(`checkpoints/${projectId}/partial/${task.id}.json`,data)}
function parseGooglePayload(payload){const text=payload?.candidates?.[0]?.content?.parts?.[0]?.text||'[]';const parsed=JSON.parse(text);if(!Array.isArray(parsed))throw new Error('Google AI did not return an array');return parsed}
function nextBatch(indexes,maxRows,dataRows,columns){const batch=[];let chars=0;for(const index of indexes){const item={index,key:String(dataRows[index]?.[columns.key]||''),text:String(dataRows[index]?.[columns.source]||'')};const size=JSON.stringify(item).length;if(batch.length&&(batch.length>=maxRows||chars+size>60_000))break;batch.push(index);chars+=size}return batch}

async function main(){
  try{
    const manifest=await readJson(`queues/${projectId}/${runId}/manifest.json`);
    if(!manifest)throw new Error('Coordinator manifest not found');
    const googleModel=manifest.model||process.env.GEMINI_MODEL||'gemini-3.6-flash';
    const projects=await readJson('projects.json');
    const project=projects?.find(item=>item.id===projectId);
    if(!project)throw new Error(`Project not found: ${projectId}`);
    const source=await readText(`projects/${project.id}/${project.fileName}`);
    if(source===null)throw new Error('Source file not found');
    const sourceHash=createHash('sha256').update(source).digest('hex');
    if(sourceHash!==manifest.sourceHash)throw new Error('Source file changed after task assignment');
    const rows=parseDelimited(source,manifest.delimiter);
    const columns=detectColumns(rows);
    const dataRows=rows.slice(1);
    const assigned=manifest.tasks.filter(task=>task.sequence%workerCount===workerIndex);
    const assignedRows=assigned.reduce((sum,item)=>sum+item.rowCount,0);
    const extension=manifest.delimiter===','?'csv':'tsv';
    const manualContent=await readText(`results/${project.id}/final.${extension}`);
    const manualRows=manualContent?parseDelimited(manualContent,manifest.delimiter):[];
    const manualColumns=manualRows.length?detectColumns(manualRows):null;
    let completedTasks=0;
    let processedRows=0;
    let apiRequests=0;
    let recentContext=[];
    let lastRequestAt=0;
    let finalStatusWritten=false;
    if(workerIndex>0)await sleep(workerIndex*baseSpacing);

    for(const task of assigned){
      const completedStored=await readJson(`checkpoints/${projectId}/tasks/${task.id}.json`);
      const stored=completedStored?.complete?completedStored:await readJson(`checkpoints/${projectId}/partial/${task.id}.json`);
      const usable=stored?.version===2&&stored.sourceHash===sourceHash&&stored.category===task.category;
      const translations=new Map((usable?stored.translations:[]).map(item=>[Number(item.index),String(item.translation||'')]));
      const taskUsage=usable?normalizeUsage(stored.usage):emptyUsage();
      if(manualColumns)for(const index of task.rowIndexes){const value=manualRows[index+1]?.[manualColumns.target];if(String(value||'').trim())translations.set(index,String(value))}
      let pending=task.rowIndexes.filter(index=>!String(translations.get(index)||'').trim());

      if(pending.length){
        const sharedPause=await readJson(`status/${projectId}/quota.json`);
        if(sharedPause?.runId===runId&&sharedPause?.reason==='daily_quota'){
          await uploadWithRetry([workerStatus('paused',{model:googleModel,currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,totalRows:assignedRows,apiRequests,pendingUsage:taskUsage,pauseReason:'daily_quota',message:'Một luồng đã phát hiện hết lượt Google hôm nay. Hệ thống sẽ tự chạy tiếp sau khi giới hạn được làm mới.',pausedAt:new Date().toISOString()})]);
          return;
        }
        let maxRows=Math.min(50,pending.length);
        let smallBatchFailures=0;
        while(pending.length){
          const elapsed=Date.now()-lastRequestAt;
          const requiredGap=baseSpacing*workerCount;
          if(lastRequestAt&&elapsed<requiredGap)await sleep(requiredGap-elapsed);
          const batchIndexes=nextBatch(pending,maxRows,dataRows,columns);
          const input=batchIndexes.map(index=>({index,key:String(dataRows[index]?.[columns.key]||''),text:String(dataRows[index]?.[columns.source]||'')}));
          const prompt=`You translate one small task in a game localization pipeline. Project: ${project.name}. Category: ${task.category}.
Translate from ${project.sourceLanguage} to ${project.targetLanguage}. Preserve placeholders, tags, variables, proper names and locations exactly. Keep terminology, pronouns, tone and capitalization consistent within this category. Translate only text; key is context.
Recent approved context from this worker: ${JSON.stringify(recentContext.slice(-12))}
Return JSON only: an array with exactly one object per input, fields index and translation. Return every index exactly once. No Markdown.

${JSON.stringify(input)}`;
          try{
            const response=await requestGoogle({prompt,temperature:0.2,label:`Google AI task ${task.id}`,model:googleModel});
            lastRequestAt=Date.now();
            apiRequests+=response.attempts;
            addUsage(taskUsage,response.usage,1);
            const parsed=parseGooglePayload(response.payload);
            const accepted=new Map(parsed.map(item=>[Number(item.index),String(item.translation||'')]).filter(([index,translation])=>batchIndexes.includes(index)&&translation.trim()));
            for(const [index,translation] of accepted)translations.set(index,translation);
            pending=task.rowIndexes.filter(index=>!String(translations.get(index)||'').trim());
            if(!accepted.size){maxRows=Math.max(5,Math.ceil(maxRows/2));smallBatchFailures+=1}else{maxRows=accepted.size<input.length?Math.max(5,Math.ceil(input.length/2)):50;smallBatchFailures=0}
          }catch(error){
            if(error instanceof GooglePauseError){
              apiRequests+=Number(error.attempts)||1;
              taskUsage.requests+=Number(error.attempts)||1;
              const pausedAt=new Date().toISOString();
              const partial={version:2,projectId,runId,sourceHash,taskId:task.id,category:task.category,model:googleModel,rowIndexes:task.rowIndexes,translations:task.rowIndexes.map(index=>({index,translation:String(translations.get(index)||'')})),complete:false,usage:taskUsage,updatedAt:pausedAt};
              const files=[taskPartialCheckpoint(task,partial),workerStatus('paused',{model:googleModel,currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,totalRows:assignedRows,apiRequests,pendingUsage:taskUsage,pauseReason:error.reason,message:error.message,pausedAt})];
              if(error.reason==='daily_quota')files.push(jsonFile(`status/${projectId}/quota.json`,{runId,model:googleModel,reason:'daily_quota',quota:error.quota,message:error.message,pausedAt,workerIndex}));
              await uploadWithRetry(files);
              console.warn(error.message);
              return;
            }
            maxRows=Math.max(5,Math.ceil(maxRows/2));
            smallBatchFailures+=1;
          }
          if(smallBatchFailures>=2&&maxRows<=5){
            const pausedAt=new Date().toISOString();
            const partial={version:2,projectId,runId,sourceHash,taskId:task.id,category:task.category,model:googleModel,rowIndexes:task.rowIndexes,translations:task.rowIndexes.map(index=>({index,translation:String(translations.get(index)||'')})),complete:false,usage:taskUsage,updatedAt:pausedAt};
            await uploadWithRetry([taskPartialCheckpoint(task,partial),workerStatus('paused',{model:googleModel,currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,totalRows:assignedRows,apiRequests,pendingUsage:taskUsage,pauseReason:'invalid_response',message:'Tác vụ đã được thu nhỏ tối đa nhưng phản hồi vẫn chưa hợp lệ. Hệ thống sẽ tự thử lại.',pausedAt})]);
            return;
          }
        }
      }

      const taskTranslations=task.rowIndexes.map(index=>({index,translation:String(translations.get(index)||'')}));
      if(!taskTranslations.every(item=>item.translation.trim()))throw new Error(`Task ${task.id} is incomplete after translation loop`);
      completedTasks+=1;
      processedRows+=task.rowCount;
      recentContext.push(...task.rowIndexes.slice(-6).map(index=>({source:String(dataRows[index]?.[columns.source]||''),translation:String(translations.get(index)||'')})));
      recentContext=recentContext.slice(-12);
      const completedAt=new Date().toISOString();
      const checkpoint={version:2,projectId,runId,sourceHash,taskId:task.id,category:task.category,model:googleModel,rowIndexes:task.rowIndexes,translations:taskTranslations,complete:true,usage:taskUsage,completedAt};
      if(!(usable&&stored.complete&&pending.length===0)){
        const isLast=completedTasks===assigned.length;
        await uploadWithRetry([taskCheckpoint(task,checkpoint),workerStatus(isLast?'completed':'running',{model:googleModel,currentTask:task.id,category:task.category,completedTasks,totalTasks:assigned.length,processedRows,totalRows:assignedRows,apiRequests,pendingUsage:emptyUsage(),completedAt:isLast?completedAt:undefined})]);
        if(isLast)finalStatusWritten=true;
      }
    }
    if(!finalStatusWritten)await uploadWithRetry([workerStatus('completed',{model:googleModel,completedTasks,totalTasks:assigned.length,processedRows,totalRows:assignedRows,apiRequests,pendingUsage:emptyUsage(),completedAt:new Date().toISOString()})]);
    console.log(`Worker ${workerIndex} completed ${completedTasks}/${assigned.length} small tasks and saved ${processedRows} rows`);
  }catch(error){
    if(error instanceof StoragePauseError){console.warn(error.message);return}
    try{await uploadWithRetry([workerStatus('failed',{error:error.message,failedAt:new Date().toISOString()})])}catch{}
    throw error;
  }
}

await main();
