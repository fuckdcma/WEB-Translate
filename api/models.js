import {allowMethods,envState,listDatasetFiles,readDatasetJson,saveDatasetFiles,send} from './_shared.js';

const configPath='config/google-ai.json';
const normalizeModel=name=>String(name||'').replace(/^models\//,'');
const excluded=/embedding|aqa|imagen|image|tts|audio|live|robotics|computer-use|deep-research|transcribe|customtools/i;
const quotaDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const safeName=value=>String(value).replace(/[^a-z0-9._-]+/gi,'-');
const clamp=(value,min,max)=>Math.min(max,Math.max(min,Number(value)||min));

function modelProfile(id){if(/lite/i.test(id))return{score:94,speed:'Rất nhanh',tone:'fast'};if(/flash/i.test(id))return{score:84,speed:'Nhanh',tone:'balanced'};if(/pro/i.test(id))return{score:64,speed:'Chất lượng cao',tone:'quality'};return{score:74,speed:'Cân bằng',tone:'balanced'}}
function normalizeLimits(profile={}){const configured=Number(profile.rpm)>0&&Number(profile.tpm)>0&&Number(profile.rpd)>0;return{rpm:Math.floor(Number(profile.rpm)>0?Number(profile.rpm):1),tpm:Math.floor(Number(profile.tpm)>0?Number(profile.tpm):8_000),rpd:Math.floor(Number(profile.rpd)>0?Number(profile.rpd):10),reservePercent:clamp(profile.reservePercent||10,5,50),source:profile.source||(configured?'configured':'safe_default'),configured}}
async function readMany(paths){const values=[];for(let offset=0;offset<paths.length;offset+=12)values.push(...await Promise.all(paths.slice(offset,offset+12).map(path=>readDatasetJson(path))));return values}

async function usageToday(paths){
  const day=quotaDay(Date.now());const perModel={};const blank=model=>perModel[model]||(perModel[model]={model,requests:0,inputTokens:0,outputTokens:0,totalTokens:0,minuteRequests:0,minuteInputTokens:0});
  const ledgerPaths=paths.filter(path=>path.startsWith(`usage/google/${day}/`)&&/\.json$/i.test(path));for(const ledger of await readMany(ledgerPaths)){if(!ledger?.model)continue;const item=blank(ledger.model);item.requests+=Number(ledger.requests)||0;item.inputTokens+=Number(ledger.inputTokens)||0;item.outputTokens+=Number(ledger.outputTokens)||0;item.totalTokens+=Number(ledger.totalTokens)||0;for(const event of ledger.events||[])if(Date.now()-Date.parse(event.at)<60_000){item.minuteRequests+=1;item.minuteInputTokens+=Number(event.inputTokens)||0}}
  const legacyPaths=paths.filter(path=>/^checkpoints\/[^/]+\/(?:(?:tasks|partial)\/[^/]+|review)\.json$/i.test(path));let estimatedRequests=0;for(const record of await readMany(legacyPaths)){const timestamp=record?.completedAt||record?.updatedAt;if(record?.version>=3||!timestamp||quotaDay(timestamp)!==day)continue;const model=record.model||'legacy';const item=blank(model);const usage=record.usage||{};item.inputTokens+=Number(usage.inputTokens)||0;item.outputTokens+=Number(usage.outputTokens)||0;item.totalTokens+=Number(usage.totalTokens)||0;if(Number(usage.requests)>0)item.requests+=Number(usage.requests);else if(record.complete){item.requests+=1;estimatedRequests+=1}}
  const totals={day,requests:0,inputTokens:0,outputTokens:0,totalTokens:0,minuteRequests:0,minuteInputTokens:0,estimatedRequests,perModel};for(const item of Object.values(perModel)){totals.requests+=item.requests;totals.inputTokens+=item.inputTokens;totals.outputTokens+=item.outputTokens;totals.totalTokens+=item.totalTokens;totals.minuteRequests+=item.minuteRequests;totals.minuteInputTokens+=item.minuteInputTokens}return totals;
}

async function availableModels(){const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY},signal:AbortSignal.timeout(30_000)});if(!response.ok)throw new Error(`Google AI trả về ${response.status}: ${(await response.text()).slice(0,180)}`);const payload=await response.json();return(payload.models||[]).filter(item=>item.supportedGenerationMethods?.includes('generateContent')).map(item=>({id:normalizeModel(item.name),name:item.displayName||normalizeModel(item.name),description:item.description||'',inputTokenLimit:Number(item.inputTokenLimit)||0,outputTokenLimit:Number(item.outputTokenLimit)||0,...modelProfile(item.name)})).filter(item=>/^gemini-/i.test(item.id)&&!excluded.test(item.id)).filter((item,index,list)=>list.findIndex(other=>other.id===item.id)===index)}

function detectedByModel(records){const map={};for(const record of records||[])if(record?.model)map[record.model]=record;return map}
function decorate(models,config,detected,usage){return models.map(model=>{const detectedProfile=detected[model.id]||{};const saved=config.limits?.[model.id]||{};const merged={rpm:saved.rpm||detectedProfile.rpm,tpm:saved.tpm||detectedProfile.tpm,rpd:saved.rpd||detectedProfile.rpd,reservePercent:saved.reservePercent||10,source:saved.source||(detectedProfile.rpm&&detectedProfile.tpm&&detectedProfile.rpd?'google_error':'safe_default')};return{...model,quota:normalizeLimits(merged),usage:usage.perModel[model.id]||{requests:0,inputTokens:0,outputTokens:0,totalTokens:0,minuteRequests:0,minuteInputTokens:0},fallback:(config.fallbacks||[]).includes(model.id)}})}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','PUT']))return;
  try{
    const state=envState();if(!state.googleAI)return send(res,503,{error:'Google AI Studio chưa được cấu hình trên Vercel'});if(!state.huggingFace)return send(res,503,{error:'Cần kết nối Hugging Face để lưu cấu hình quota'});
    const paths=await listDatasetFiles();let config=await readDatasetJson(configPath)||{};let selected=normalizeModel(config.model||state.model);const models=await availableModels();
    if(req.method==='PUT'){
      const requested=normalizeModel(req.body?.model||selected);if(!models.some(item=>item.id===requested))return send(res,400,{error:'Model này hiện không khả dụng cho API dịch'});
      if(req.body?.action==='select'){selected=requested;config.fallbacks=(config.fallbacks||[]).filter(model=>model!==selected)}
      if(req.body?.action==='quota'){const rpm=Number(req.body?.rpm),tpm=Number(req.body?.tpm),rpd=Number(req.body?.rpd),reservePercent=Number(req.body?.reservePercent||10);if(!(rpm>0&&tpm>0&&rpd>0))return send(res,400,{error:'RPM, TPM và RPD phải lớn hơn 0'});config.limits={...(config.limits||{}),[requested]:{rpm:Math.floor(rpm),tpm:Math.floor(tpm),rpd:Math.floor(rpd),reservePercent:clamp(reservePercent,5,50),source:'configured',updatedAt:new Date().toISOString()}}}
      if(req.body?.action==='fallback'){const fallbacks=new Set(config.fallbacks||[]);if(req.body.enabled)fallbacks.add(requested);else fallbacks.delete(requested);fallbacks.delete(selected);config.fallbacks=[...fallbacks]}
      config={...config,model:selected,updatedAt:new Date().toISOString()};await saveDatasetFiles([{path:configPath,content:new Blob([JSON.stringify(config,null,2)],{type:'application/json'})}]);
    }
    const usage=await usageToday(paths);const limitPaths=paths.filter(path=>path.startsWith('usage/google/limits/')&&/\.json$/i.test(path));const detected=detectedByModel(await readMany(limitPaths));const ranked=decorate(models,config,detected,usage).sort((a,b)=>Number(b.id===selected)-Number(a.id===selected)||Number(b.fallback)-Number(a.fallback)||Number(/flash/i.test(b.id))-Number(/flash/i.test(a.id))||b.score-a.score||a.name.localeCompare(b.name));const selectedModel=ranked.find(item=>item.id===selected)||ranked[0];
    send(res,200,{selected,fallbacks:config.fallbacks||[],selectedQuota:selectedModel?.quota||normalizeLimits(),usage,models:ranked.slice(0,18),quotaSource:selectedModel?.quota?.source||'safe_default',note:'Google models API cung cấp giới hạn ngữ cảnh. RPM/TPM/RPD được lưu theo model từ cấu hình hoặc số Google trả về khi giới hạn phát sinh.',updatedAt:new Date().toISOString()});
  }catch(error){send(res,500,{error:error.message})}
}
