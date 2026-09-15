import {spawn} from 'node:child_process';
import {readJson} from './hf-pipeline.mjs';

const required=['PROJECT_ID','RUN_ID','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const projectId=process.env.PROJECT_ID;

function run(script){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script],{stdio:'inherit',env:process.env});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${script} exited with code ${code}`)));
  });
}

await run('scripts/coordinate-project.mjs');
if((await readJson(`status/${projectId}/coordinator.json`))?.status!=='completed')process.exit(0);
await run('scripts/analyze-project.mjs');
if((await readJson(`status/${projectId}/analysis.json`))?.status!=='completed')process.exit(0);
await run('scripts/translate-worker.mjs');
if((await readJson(`status/${projectId}/worker-0.json`))?.status!=='completed')process.exit(0);
await run('scripts/review-project.mjs');
