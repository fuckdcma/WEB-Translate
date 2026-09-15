import {allowMethods,readDatasetJson,send} from './_shared.js';
import {fetchGoogleQuotaSnapshot,googleCloudMonitorConfigured} from '../scripts/google-cloud-monitor.mjs';

let cached=null;
const pacificDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const normalizeModel=value=>String(value||'').replace(/^models\//,'');
const percent=(value,limit)=>limit>0?Math.max(0,Math.round(Number(value||0)/limit*1000)/10):null;

async function internalUsage(model){
  const day=pacificDay(Date.now());const ledger=await readDatasetJson(`usage/google/${day}/${model.replace(/[^a-z0-9._-]+/gi,'-')}.json`)||{};const events=(ledger.events||[]).filter(event=>Date.now()-Date.parse(event.at)<60_000);return{day,model,rpm:events.length,tpm:events.reduce((sum,event)=>sum+(Number(event.inputTokens)||0),0),rpd:Number(ledger.requests)||0,inputTokens:Number(ledger.inputTokens)||0,outputTokens:Number(ledger.outputTokens)||0,totalTokens:Number(ledger.totalTokens)||0,updatedAt:ledger.updatedAt||null}}

function findGoogleModel(snapshot,model){
  const entries=Object.entries(snapshot?.models||{});return snapshot?.models?.[model]||entries.find(([name])=>normalizeModel(name)===model)?.[1]||entries.find(([name])=>model.startsWith(normalizeModel(name))||normalizeModel(name).startsWith(model))?.[1]||null;
}

function comparison(internal,google){
  const result={};for(const dimension of ['rpm','tpm','rpd']){const local=Number(internal[dimension])||0;const observed=google?.[dimension]?.usage;const limit=google?.[dimension]?.limit;result[dimension]={internal:local,google:observed===null||observed===undefined?null:Number(observed),limit:limit===null||limit===undefined?null:Number(limit),difference:observed===null||observed===undefined?null:local-Number(observed),internalPercent:percent(local,Number(limit)),googlePercent:percent(Number(observed),Number(limit)),exceeded:Number(google?.[dimension]?.exceeded)||0,observedAt:google?.[dimension]?.observedAt||null}}
  return result;
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET']))return;
  try{
    const config=await readDatasetJson('config/google-ai.json')||{};const model=normalizeModel(req.query?.model||config.model||process.env.GEMINI_MODEL||'gemini-3.6-flash');const internal=await internalUsage(model);
    const force=String(req.query?.refresh||'')==='1';const stored=await readDatasetJson('usage/google/cloud-monitor-latest.json');let direct=null;
    if(googleCloudMonitorConfigured())try{if(force||!cached||Date.now()-cached.at>60_000)cached={at:Date.now(),value:await fetchGoogleQuotaSnapshot()};direct=cached.value}catch{}
    const directObserved=Number(direct?.sources?.monitoringSeries)>0;const storedObserved=Number(stored?.sources?.monitoringSeries)>0;const snapshot=directObserved?direct:storedObserved?stored:direct||stored;
    if(!snapshot)return send(res,200,{configured:false,status:'setup_required',model,internal,google:null,comparison:comparison(internal,null),message:'Chưa có bản đối chứng Google. Trình đồng bộ trên máy sẽ tự gửi dữ liệu khi máy đang bật.'});
    const source=directObserved?'google_cloud':'local_collector';const google=findGoogleModel(snapshot,model);const syncAge=Math.max(0,Math.round((Date.now()-Date.parse(snapshot.syncedAt||0))/1000));const status=!google?'waiting':syncAge>15*60?'stale':'connected';send(res,200,{configured:true,status,source,model,internal,google,comparison:comparison(internal,google),projectId:snapshot.projectId,syncedAt:snapshot.syncedAt,newestAt:snapshot.newestAt,lagSeconds:snapshot.lagSeconds,syncAgeSeconds:syncAge,sources:snapshot.sources,errors:snapshot.errors,message:google?(source==='local_collector'?'Số Google chính thức được máy của bạn đồng bộ tự động, không cần bật thanh toán.':'Đang đối chứng số realtime nội bộ với số Google Cloud ghi nhận.'):'Google Cloud chưa trả dữ liệu cho model này.'});
  }catch(error){send(res,200,{configured:true,status:'error',error:error.message,message:'Chưa đọc được dữ liệu đối chứng từ Google Cloud.'})}
}
