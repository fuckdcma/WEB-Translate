import {allowMethods,envState,readDatasetJson,saveDatasetFiles,send} from './_shared.js';

const configPath='config/google-ai.json';
const normalizeModel=name=>String(name||'').replace(/^models\//,'');
const excluded=/embedding|aqa|imagen|image|tts|audio|live|robotics|computer-use|deep-research/i;

function modelProfile(id){
  if(/lite/i.test(id))return{score:94,speed:'Rất nhanh',tone:'fast'};
  if(/flash/i.test(id))return{score:84,speed:'Nhanh',tone:'balanced'};
  if(/pro/i.test(id))return{score:64,speed:'Chất lượng cao',tone:'quality'};
  return{score:74,speed:'Cân bằng',tone:'balanced'};
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
    const stored=state.huggingFace?await readDatasetJson(configPath):null;
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
    send(res,200,{selected,models:ranked.slice(0,18),updatedAt:new Date().toISOString()});
  }catch(error){send(res,500,{error:error.message})}
}
