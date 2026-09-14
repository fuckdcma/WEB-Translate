import { downloadFile, uploadFiles } from '@huggingface/hub';

const required=['PROJECT_ID','RUN_ID','SHARD_COUNT','HF_TOKEN','HF_DATASET_REPO','GEMINI_API_KEY'];
for(const key of required)if(!process.env[key])throw new Error(`Missing required secret or variable: ${key}`);
const repo={type:'dataset',name:process.env.HF_DATASET_REPO};
const accessToken=process.env.HF_TOKEN;
const projectId=process.env.PROJECT_ID;
const runId=process.env.RUN_ID;
const shardCount=Math.min(16,Math.max(1,Number(process.env.SHARD_COUNT)||1));

async function writeStatus(status,extra={}){
  let lastError;
  for(let attempt=0;attempt<4;attempt+=1)try{
    await uploadFiles({repo,accessToken,files:[{path:`status/${projectId}/review.json`,content:new Blob([JSON.stringify({runId,status,updatedAt:new Date().toISOString(),...extra},null,2)],{type:'application/json'})}]});
    return;
  }catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)))}
  throw lastError;
}

async function main(){
  await writeStatus('running',{progress:0,checkedRows:0,startedAt:new Date().toISOString()});
  try{
    const rows=[];
    for(let index=0;index<shardCount;index+=1){
      const response=await downloadFile({repo,path:`results/${projectId}/shard-${index}.tsv`,accessToken});
      if(!response)throw new Error(`Missing translation result for shard ${index}`);
      const lines=(await response.text()).trim().split(/\r?\n/);
      lines.shift();
      for(const line of lines)rows.push({shard:index,text:line});
    }

    const issues=[];
    let lastReportedProgress=0;
    for(let offset=0;offset<rows.length;offset+=60){
      const batch=rows.slice(offset,offset+60).map((row,index)=>({row:offset+index+1,text:row.text}));
      const prompt=`You are the independent reviewer for Vietnamese game localization. Check every supplied line for missing translation, broken placeholders, altered proper names or locations, inconsistent pronouns, and meaning that conflicts with story context. Return JSON only as an object with an issues array. Each issue must contain row, severity (critical, warning, or note), and message in Vietnamese. Return an empty issues array when the batch is good.\n\n${JSON.stringify(batch)}`;
      const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.1}})});
      if(!response.ok)throw new Error(`Google AI review failed: ${response.status} ${await response.text()}`);
      const payload=await response.json();
      const result=JSON.parse(payload.candidates?.[0]?.content?.parts?.[0]?.text||'{"issues":[]}');
      if(Array.isArray(result.issues))issues.push(...result.issues);
      const checkedRows=Math.min(rows.length,offset+batch.length);
      const progress=rows.length?Math.round(checkedRows/rows.length*100):100;
      if(progress>=lastReportedProgress+10&&progress<100){await writeStatus('running',{progress,checkedRows,totalRows:rows.length,issueCount:issues.length});lastReportedProgress=progress}
    }

    const report={projectId,checkedRows:rows.length,issueCount:issues.length,issues,completedAt:new Date().toISOString()};
    await uploadFiles({repo,accessToken,files:[{path:`results/${projectId}/review.json`,content:new Blob([JSON.stringify(report,null,2)],{type:'application/json'})}]});
    await writeStatus('completed',{progress:100,checkedRows:rows.length,totalRows:rows.length,issueCount:issues.length,completedAt:report.completedAt});
    console.log(`Reviewed ${rows.length} rows and found ${issues.length} issues`);
  }catch(error){
    try{await writeStatus('failed',{error:error.message,failedAt:new Date().toISOString()})}catch(statusError){console.error('Could not save failed review status:',statusError.message)}
    throw error;
  }
}

await main();
