import {timingSafeEqual} from 'node:crypto';
import {allowMethods,saveDatasetFiles,send} from './_shared.js';

const snapshotPath='usage/google/cloud-monitor-latest.json';

function sameSecret(actual,expected){
  const left=Buffer.from(String(actual||''));const right=Buffer.from(String(expected||''));
  return left.length===right.length&&left.length>0&&timingSafeEqual(left,right);
}

function numberOrNull(value){if(value===null||value===undefined||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null}
function cleanDimension(value={}){return{usage:numberOrNull(value.usage),peakUsage:numberOrNull(value.peakUsage),todayUsage:numberOrNull(value.todayUsage),limit:numberOrNull(value.limit),limitSource:String(value.limitSource||'').slice(0,40)||null,exceeded:numberOrNull(value.exceeded)||0,observedAt:value.observedAt||null,metric:String(value.metric||'').slice(0,180)||null}}
function cleanSnapshot(value={}){
  const models={};for(const [name,data] of Object.entries(value.models||{})){const model=String(name).replace(/^models\//,'').replace(/[^a-z0-9._-]+/gi,'-').slice(0,100);if(!model)continue;models[model]={rpm:cleanDimension(data?.rpm),tpm:cleanDimension(data?.tpm),rpd:cleanDimension(data?.rpd),tpd:cleanDimension(data?.tpd)}}
  return{version:1,projectId:String(value.projectId||''),projectNumber:String(value.projectNumber||''),syncedAt:value.syncedAt||new Date().toISOString(),receivedAt:new Date().toISOString(),newestAt:value.newestAt||null,lagSeconds:numberOrNull(value.lagSeconds),models,sources:{monitoringSeries:numberOrNull(value.sources?.monitoringSeries)||0,monitoringMetricTypes:numberOrNull(value.sources?.monitoringMetricTypes)||0,serviceUsageBuckets:numberOrNull(value.sources?.serviceUsageBuckets)||0},errors:value.errors&&typeof value.errors==='object'?value.errors:{}};
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['POST']))return;
  try{
    const expected=process.env.QUOTA_MONITOR_INGEST_SECRET;const actual=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!expected)return send(res,503,{error:'Bộ nhận dữ liệu quota chưa được cấu hình'});
    if(!sameSecret(actual,expected))return send(res,401,{error:'Không có quyền gửi dữ liệu quota'});
    const snapshot=cleanSnapshot(req.body||{});if(snapshot.projectId!==process.env.GOOGLE_CLOUD_PROJECT_ID)return send(res,422,{error:'Dữ liệu không thuộc Google Project đã cấu hình'});
    const syncedAt=Date.parse(snapshot.syncedAt);if(!Number.isFinite(syncedAt)||Math.abs(Date.now()-syncedAt)>30*60_000)return send(res,422,{error:'Bản đối chứng đã quá cũ hoặc sai thời gian'});
    if(!snapshot.sources.monitoringSeries||!Object.keys(snapshot.models).length)return send(res,422,{error:'Google chưa trả dữ liệu sử dụng để lưu'});
    await saveDatasetFiles([{path:snapshotPath,content:new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'})}]);
    send(res,200,{ok:true,receivedAt:snapshot.receivedAt,newestAt:snapshot.newestAt,models:Object.keys(snapshot.models).length});
  }catch(error){send(res,500,{error:error.message})}
}
