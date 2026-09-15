import {createSign} from 'node:crypto';

const scope='https://www.googleapis.com/auth/cloud-platform';
let tokenCache=null;

const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
const normalizeModel=value=>String(value||'unknown').replace(/^models\//,'');
const numberValue=value=>Number(value?.int64Value??value?.doubleValue??value?.distributionValue?.mean??0)||0;
const pacificDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));

function credentials(){
  const raw=process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if(!raw)return null;
  try{return JSON.parse(raw)}catch{}
  try{return JSON.parse(Buffer.from(raw,'base64').toString('utf8'))}catch{}
  throw new Error('Thông tin kết nối Google Cloud không hợp lệ');
}

async function accessToken(){
  if(process.env.GOOGLE_CLOUD_ACCESS_TOKEN)return process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
  if(tokenCache?.expiresAt>Date.now()+60_000)return tokenCache.value;
  const account=credentials();
  if(!account?.client_email||!account?.private_key)throw new Error('Chưa cấu hình quyền đọc Google Cloud');
  const now=Math.floor(Date.now()/1000);
  const header=encode({alg:'RS256',typ:'JWT'});
  const claims=encode({iss:account.client_email,scope,aud:account.token_uri||'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
  const unsigned=`${header}.${claims}`;
  const signer=createSign('RSA-SHA256');signer.update(unsigned);signer.end();
  const assertion=`${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;
  const response=await fetch(account.token_uri||'https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error(`Google từ chối quyền đọc (${response.status})`);
  const payload=await response.json();tokenCache={value:payload.access_token,expiresAt:Date.now()+(Number(payload.expires_in)||3600)*1000};return tokenCache.value;
}

async function googleJson(url,token){
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(45_000)});
  if(!response.ok){const detail=await response.text();const error=new Error(`Google Cloud trả về ${response.status}: ${detail.slice(0,240)}`);error.status=response.status;throw error}
  return response.json();
}

function dimensionFor(type,limitName=''){
  if(/input_token_count/i.test(type))return/day|daily|per.?day/i.test(limitName)?'tpd':'tpm';
  if(!/requests/i.test(type))return null;
  return/day|daily|per.?day/i.test(limitName)?'rpd':'rpm';
}

function blankDimension(){return{usage:null,peakUsage:null,todayUsage:null,limit:null,limitSource:null,exceeded:0,observedAt:null,metric:null}}
function blankModel(){return{rpm:blankDimension(),tpm:blankDimension(),rpd:blankDimension(),tpd:blankDimension()}}

function summarizeTimeSeries(series=[]){
  const models={};const today=pacificDay(Date.now());let newest=0;
  for(const item of series){
    const type=String(item.metric?.type||'');const kind=type.split('/').at(-1);if(!['usage','limit','exceeded'].includes(kind))continue;
    const labels=item.metric?.labels||{};const model=normalizeModel(labels.model);const dimension=dimensionFor(type,labels.limit_name);if(!dimension)continue;
    const target=models[model]||(models[model]=blankModel());const cell=target[dimension];const points=Array.isArray(item.points)?item.points:[];if(!points.length)continue;
    const dated=points.map(point=>({at:Date.parse(point.interval?.endTime||point.interval?.startTime||0),value:numberValue(point.value)})).filter(point=>Number.isFinite(point.at)).sort((a,b)=>b.at-a.at);if(!dated.length)continue;
    const todayPoints=dated.filter(point=>pacificDay(point.at)===today);cell.metric=type;
    if(kind==='limit'){cell.limit=Math.max(Number(cell.limit)||0,...dated.map(point=>point.value));cell.limitSource='cloud_monitoring'}
    else if(kind==='exceeded')cell.exceeded=Number(cell.exceeded||0)+todayPoints.reduce((sum,point)=>sum+point.value,0);
    else{
      newest=Math.max(newest,dated[0].at);cell.observedAt=new Date(Math.max(Date.parse(cell.observedAt||0)||0,dated[0].at)).toISOString();
      const todayUsage=todayPoints.reduce((sum,point)=>sum+point.value,0);const peakUsage=todayPoints.length?Math.max(...todayPoints.map(point=>point.value)):0;
      cell.todayUsage=Number(cell.todayUsage||0)+todayUsage;cell.peakUsage=Math.max(Number(cell.peakUsage)||0,peakUsage);
      if(dimension==='rpd'||dimension==='tpd')cell.usage=Number(cell.usage||0)+todayUsage;
      else cell.usage=Number(cell.usage||0)+dated[0].value;
    }
  }
  return{models,newestAt:newest?new Date(newest).toISOString():null};
}

async function metricTypes(projectId,token){
  const filter='metric.type = starts_with("generativelanguage.googleapis.com/quota/generate_content_")';
  const url=`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/metricDescriptors?filter=${encodeURIComponent(filter)}&pageSize=200`;
  const payload=await googleJson(url,token);
  return(payload.metricDescriptors||[]).map(item=>item.type).filter(type=>/\/(usage|limit|exceeded)$/.test(type)&&/(?:free_tier|paid_tier_[123])_(?:requests|input_token_count)\//.test(type));
}

async function timeSeriesFor(projectId,type,token,startTime,endTime){
  const filter=`metric.type = "${type}"`;
  const params=new URLSearchParams({filter,'interval.startTime':startTime,'interval.endTime':endTime,view:'FULL',pageSize:'1000'});
  const payload=await googleJson(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries?${params}`,token);
  return payload.timeSeries||[];
}

async function monitoringSnapshot(projectId,token){
  const types=await metricTypes(projectId,token);const endTime=new Date().toISOString();const startTime=new Date(Date.now()-30*60*60_000).toISOString();const all=[];
  for(let offset=0;offset<types.length;offset+=4){const group=types.slice(offset,offset+4);const values=await Promise.all(group.map(type=>timeSeriesFor(projectId,type,token,startTime,endTime)));for(const rows of values)all.push(...rows)}
  return{...summarizeTimeSeries(all),metricTypes:types,length:all.length};
}

export function googleCloudMonitorConfigured(){return Boolean(process.env.GOOGLE_CLOUD_PROJECT_ID&&(process.env.GOOGLE_CLOUD_ACCESS_TOKEN||process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_JSON))}

export async function fetchGoogleQuotaSnapshot(){
  const projectId=process.env.GOOGLE_CLOUD_PROJECT_ID;const projectNumber=process.env.GOOGLE_CLOUD_PROJECT_NUMBER||credentials()?.project_number;
  if(!projectId)throw new Error('Chưa cấu hình GOOGLE_CLOUD_PROJECT_ID');const token=await accessToken();const errors={};let monitoring={models:{},metricTypes:[],length:0,newestAt:null};
  try{monitoring=await monitoringSnapshot(projectId,token)}catch(error){errors.monitoring=error.message}
  if(errors.monitoring)throw new Error(errors.monitoring);
  return{version:1,projectId,projectNumber:projectNumber||null,syncedAt:new Date().toISOString(),newestAt:monitoring.newestAt,lagSeconds:monitoring.newestAt?Math.max(0,Math.round((Date.now()-Date.parse(monitoring.newestAt))/1000)):null,models:monitoring.models,sources:{monitoringSeries:monitoring.length,monitoringMetricTypes:monitoring.metricTypes.length,serviceUsageBuckets:0},errors};
}
