import {GooglePauseError,makeBatches,requestGoogle} from './google-api.mjs';
import {jsonFile,readJson,readText,StoragePauseError,textFile,uploadWithRetry} from './hf-pipeline.mjs';
import {detectColumns,parseDelimited,serializeDelimited} from './tabular.mjs';

const required=['PROJECT_ID','RUN_ID','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const projectId=process.env.PROJECT_ID;const runId=process.env.RUN_ID;const checkpointPath=`checkpoints/${projectId}/review.json`;const statusPath=`status/${projectId}/review.json`;
const statusFile=(status,extra={})=>jsonFile(statusPath,{runId,status,updatedAt:new Date().toISOString(),...extra});

async function main(){
  try{
    const manifest=await readJson(`queues/${projectId}/${runId}/manifest.json`);if(!manifest)throw new Error('Coordinator manifest not found');const googleModel=manifest.model||process.env.GEMINI_MODEL||'gemini-3.6-flash';
    const projects=await readJson('projects.json');const project=projects?.find(item=>item.id===projectId);if(!project)throw new Error(`Project not found: ${projectId}`);
    const source=await readText(`projects/${project.id}/${project.fileName}`);if(source===null)throw new Error('Source file not found');
    const rows=parseDelimited(source,manifest.delimiter);const columns=detectColumns(rows);const dataRows=rows.slice(1);const translations=new Map();const categoryByIndex=new Map();const missingTasks=[];
    for(const task of manifest.tasks){
      task.rowIndexes.forEach(index=>categoryByIndex.set(index,task.category));const checkpoint=await readJson(`checkpoints/${projectId}/tasks/${task.id}.json`);
      if(checkpoint?.version!==2||checkpoint.sourceHash!==manifest.sourceHash||!checkpoint.complete){missingTasks.push(task.id);continue}
      for(const item of checkpoint.translations||[])if(String(item.translation||'').trim())translations.set(Number(item.index),String(item.translation));
      if(task.rowIndexes.some(index=>!translations.has(index)))missingTasks.push(task.id);
    }
    if(missingTasks.length){await uploadWithRetry([statusFile('paused',{progress:0,checkedRows:0,totalRows:dataRows.length,totalTasks:manifest.totalTasks,missingTasks:missingTasks.slice(0,100),pauseReason:'translation_incomplete',message:`Đã lưu các tác vụ hoàn thành. Còn ${missingTasks.length} tác vụ cần dịch.`,pausedAt:new Date().toISOString()})]);console.warn(`Review waiting for ${missingTasks.length} tasks`);return}

    const extension=manifest.delimiter===','?'csv':'tsv';const manualContent=await readText(`results/${project.id}/final.${extension}`);
    if(manualContent){const manualRows=parseDelimited(manualContent,manifest.delimiter);const manualColumns=detectColumns(manualRows);manualRows.slice(1).forEach((row,index)=>{if(String(row[manualColumns.target]||'').trim())translations.set(index,String(row[manualColumns.target]))})}
    const stored=await readJson(checkpointPath);const usable=stored?.version===2&&stored.sourceHash===manifest.sourceHash;const issues=Array.isArray(usable?stored.issues:null)?[...stored.issues]:[];const corrections=new Map((usable?stored.corrections:[]).map(item=>[Number(item.index),String(item.translation||'')]));let checkedRows=Math.min(dataRows.length,Number(usable?stored.checkedRows:0)||0);let apiRequests=Number(usable?stored.apiRequests:0)||0;
    await uploadWithRetry([statusFile('running',{progress:dataRows.length?Math.round(checkedRows/dataRows.length*100):100,checkedRows,totalRows:dataRows.length,issueCount:issues.length,correctionCount:corrections.size,resumed:Boolean(usable)})]);
    const remaining=dataRows.slice(checkedRows).map((row,offset)=>{const index=checkedRows+offset;return{index,key:String(row[columns.key]||''),source:String(row[columns.source]||''),translation:String(translations.get(index)||''),category:categoryByIndex.get(index)||'story'}});const batches=makeBatches(remaining,item=>item,{maxRows:50,maxChars:80_000});
    for(const batch of batches){
      const prompt=`You are the final quality reviewer for a Vietnamese game localization. Review this small batch using story context and category. Check missing meaning, placeholders, tags, proper names, locations, terminology, pronouns, tone, capitalization and menu brevity. Suggest a correction only when needed.
Return JSON only as {"issues":[{"index":0,"severity":"critical|warning|note","message":"Vietnamese explanation"}],"corrections":[{"index":0,"translation":"corrected Vietnamese"}]}. Do not omit valid lines from consideration. No Markdown.

${JSON.stringify(batch)}`;
      let response;
      try{response=await requestGoogle({prompt,temperature:0.1,label:'Google AI final review',model:googleModel});apiRequests+=response.attempts}
      catch(error){if(!(error instanceof GooglePauseError))throw error;apiRequests+=Number(error.attempts)||1;const checkpoint={version:2,projectId,sourceHash:manifest.sourceHash,checkedRows,issues,corrections:[...corrections].map(([index,translation])=>({index,translation})),apiRequests,updatedAt:new Date().toISOString()};const progress=dataRows.length?Math.round(checkedRows/dataRows.length*100):100;await uploadWithRetry([jsonFile(checkpointPath,checkpoint),statusFile('paused',{progress,checkedRows,totalRows:dataRows.length,issueCount:issues.length,correctionCount:corrections.size,apiRequests,pauseReason:error.reason,message:error.message,pausedAt:new Date().toISOString()})]);console.warn(error.message);return}
      const result=JSON.parse(response.payload?.candidates?.[0]?.content?.parts?.[0]?.text||'{"issues":[],"corrections":[]}');if(Array.isArray(result.issues))issues.push(...result.issues);if(Array.isArray(result.corrections))for(const item of result.corrections)if(batch.some(row=>row.index===Number(item.index))&&String(item.translation||'').trim())corrections.set(Number(item.index),String(item.translation));checkedRows+=batch.length;
    }

    dataRows.forEach((row,index)=>{row[columns.target]=corrections.get(index)||translations.get(index)||''});const output=serializeDelimited(rows,manifest.delimiter);const completedAt=new Date().toISOString();const report={version:2,projectId,sourceHash:manifest.sourceHash,checkedRows:dataRows.length,issueCount:issues.length,correctionCount:corrections.size,issues,corrections:[...corrections].map(([index,translation])=>({index,translation})),categories:manifest.categories,apiRequests,completedAt};const checkpoint={...report,complete:true,updatedAt:completedAt};
    await uploadWithRetry([textFile(`results/${project.id}/final.${extension}`,output,manifest.delimiter===','?'text/csv':'text/tab-separated-values'),jsonFile(`results/${projectId}/review.json`,report),jsonFile(checkpointPath,checkpoint),statusFile('completed',{progress:100,checkedRows:dataRows.length,totalRows:dataRows.length,issueCount:issues.length,correctionCount:corrections.size,apiRequests,completedAt})]);
    console.log(`Final reviewer checked ${dataRows.length} rows, found ${issues.length} issues and applied ${corrections.size} corrections`);
  }catch(error){if(error instanceof StoragePauseError){console.warn(error.message);return}try{await uploadWithRetry([statusFile('failed',{error:error.message,failedAt:new Date().toISOString()})])}catch{}throw error}
}

await main();
