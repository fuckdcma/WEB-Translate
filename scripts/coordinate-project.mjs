import {createHash} from 'node:crypto';
import {jsonFile,readJson,readText,StoragePauseError,uploadWithRetry} from './hf-pipeline.mjs';
import {detectColumns,parseDelimited} from './tabular.mjs';
import {buildTaskPlan} from './task-plan.mjs';

const required=['PROJECT_ID','RUN_ID','WORKER_COUNT','HF_TOKEN','HF_DATASET_REPO'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const projectId=process.env.PROJECT_ID;const runId=process.env.RUN_ID;const workerCount=1;

async function main(){
  try{
    const projects=await readJson('projects.json');const project=projects?.find(item=>item.id===projectId);if(!project)throw new Error(`Project not found: ${projectId}`);
    const googleConfig=await readJson('config/google-ai.json')||{};const model=googleConfig.model||process.env.GEMINI_MODEL||'gemini-3.6-flash';
    const source=await readText(`projects/${project.id}/${project.fileName}`);if(source===null)throw new Error('Source file not found');
    const sourceHash=createHash('sha256').update(source).digest('hex');const delimiter=/\.csv$/i.test(project.fileName)?',':'\t';const rows=parseDelimited(source,delimiter);const columns=detectColumns(rows);const dataRows=rows.slice(1);const {taskSize,tasks,categories}=buildTaskPlan(dataRows.map(row=>({key:row[columns.key],text:row[columns.source]})));const compactSource=dataRows.map((row,index)=>`${index+1}\t${String(row[columns.source]||'')}`).join('\n');const estimatedInputTokens=Math.max(1,Math.ceil(compactSource.length/4));const createdAt=new Date().toISOString();
    const manifest={version:3,projectId,runId,sourceHash,delimiter,taskSize,workerCount,model,googleConfig,totalRows:dataRows.length,totalTasks:tasks.length,estimatedInputTokens,categories,tasks,createdAt};
    await uploadWithRetry([jsonFile(`queues/${projectId}/${runId}/manifest.json`,manifest),jsonFile(`status/${projectId}/coordinator.json`,{runId,status:'completed',architecture:'quota-queue-v3',taskSize,workerCount,model,totalTasks:tasks.length,totalRows:dataRows.length,estimatedInputTokens,categories,completedAt:createdAt})]);
    console.log(`Coordinator created ${tasks.length} tasks of ${taskSize} rows: menu=${categories.menu}, interaction=${categories.interaction}, story=${categories.story}`);
  }catch(error){if(error instanceof StoragePauseError){console.warn(error.message);return}throw error}
}

await main();
