import {allowMethods,envState,listDatasetFiles,readDatasetJson,saveDatasetFiles,send} from './_shared.js';

const configPath='config/google-ai.json';
const normalizeModel=name=>String(name||'').replace(/^models\//,'');
const excluded=/embedding|aqa|imagen|image|tts|audio|live|robotics|computer-use|deep-research|transcribe|customtools/i;

function modelProfile(id){
  if(/lite/i.test(id))return{score:94,speed:'Rất nhanh',tone:'fast'};
  if(/flash/i.test(id))return{score:84,speed:'Nhanh',tone:'balanced'};
  if(/pro/i.test(id))return{score:64,speed:'Chất lượng cao',tone:'quality'};
  return{score:74,speed:'Cân bằng',tone:'balanced'};
}

const quotaDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
async function readMany(paths){const values=[];for(let offset=0;offset<paths.length;offset+=12)values.push(...await Promise.all(paths.slice(offset,offset+12).map(path=>readDatasetJson(path))));return values}
async function usageToday(){
  const day=quotaDay(Date.now());
  const paths=await listDatasetFiles();
  const taskPaths=paths.filter(path=>/^checkpoints\/[^/]+\/(tasks|partial)\/[^/]+\.json$/i.test(path));
  const preferred=new Map();
  for(const path of taskPaths){const key=path.replace('/partial/','/tasks/');if(!preferred.has(key)||path.includes('/tasks/'))preferred.set(key,path)}
  const reviewPaths=paths.filter(path=>/^checkpoints\/[^/]+\/review\.json$/i.test(path));
  const records=await readMany([...preferred.values(),...reviewPaths]);
  const totals={day,inputTokens:0,outputTokens:0,totalTokens:0,requests:0,estimatedRequests:0,tokenPerDay:null,requestsPerDay:null,tokensPerMinute:null,requestsPerMinute:null};
  for(const record of records){const timestamp=record?.completedAt||record?.updatedAt;if(!timestamp||quotaDay(timestamp)!==day)continue;const usage=record?.usage||{};totals.inputTokens+=Number(usage.inputTokens)||0;totals.outputTokens+=Number(usage.outputTokens)||0;totals.totalTokens+=Number(usage.totalTokens)||0;if(Number(usage.requests)>0)totals.requests+=Number(usage.requests);else if(record?.complete){totals.requests+=1;totals.estimatedRequests+=1}}
  const quotaPaths=paths.filter(path=>/^status\/[^/]+\/quota\.json$/i.test(path));
  const quotas=await readMany(quotaPaths);
  const latest=quotas.filter(item=>item?.pausedAt&&quotaDay(item.pausedAt)===day).sort((a,b)=>Date.parse(b.pausedAt)-Date.parse(a.pausedAt))[0]?.quota||{};
  totals.tokenPerDay=Number(latest.tokenPerDay)||null;totals.requestsPerDay=Number(latest.requestsPerDay)||null;totals.tokensPerMinute=Number(latest.tokensPerMinute)||null;totals.requestsPerMinute=Number(latest.requestsPerMinute)||null;
  return totals;
}

async function availableModels(){
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY},signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error(`Google AI trả về ${response.status}: ${(await response.text()).slice(0,180)}`);
  const payload=await response.json();
  return (payload.models||[]).filter(item=>item.supportedGenerationMethods?.includes('generateContent')).map(item=>({id:normalizeModel(item.name),name:item.displayName||normalizeModel(item.name),description:item.description||'',inputTokenLimit:Number(item.inputTokenLimit)||0,outputTokenLimit:Number(item.outputTokenLimit)||0,...modelProfile(item.name)})).filter(item=>/^gemini-/i.test(item.id)&&!excluded.test(item.id)).filter((item,index,list)=>list.findIndex(other=>other.id===item.id)===index);
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','PUT']))return;
  try{
    const state=envState();
    if(!state.googleAI)return send(res,503,{error:'Google AI Studio chưa được cấu hình trên Vercel'});
    const [stored,usage]=state.huggingFace?await Promise.all([readDatasetJson(configPath),usageToday()]):[null,{day:quotaDay(Date.now()),inputTokens:0,outputTokens:0,totalTokens:0,requests:0,estimatedRequests:0,tokenPerDay:null,requestsPerDay:null,tokensPerMinute:null,requestsPerMinute:null}];
    let selected=normalizeModel(stored?.model||state.model);
    const models=await availableModels();
    if(req.method==='PUT'){
      const requested=normalizeModel(req.body?.model);
      if(!models.some(item=>item.id===requested))return send(res,400,{error:'Model này hiện không khả dụng cho API dịch'});
      if(!state.huggingFace)return send(res,503,{error:'Cần kết nối Hugging Face để lưu lựa chọn model'});
      selected=requested;
      const updatedAt=new Date().toISOString();
      await saveDatasetFiles([{path:configPath,content:new Blob([JSON.stringify({model:selected,updatedAt},null,2)],{type:'application/json'})}]);
    }
    const ranked=models.sort((a,b)=>Number(b.id===selected)-Number(a.id===selected)||Number(/flash/i.test(b.id))-Number(/flash/i.test(a.id))||b.score-a.score||a.name.localeCompare(b.name));
    send(res,200,{selected,models:ranked.slice(0,18),usage,updatedAt:new Date().toISOString()});
  }catch(error){send(res,500,{error:error.message})}
}
