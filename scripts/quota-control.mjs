import {countGoogleTokens,GooglePauseError,requestGoogle,sleep} from './google-api.mjs';
import {jsonFile,readJson,uploadWithRetry} from './hf-pipeline.mjs';

const clamp=(value,min,max)=>Math.min(max,Math.max(min,Number(value)||min));
const safeName=value=>String(value).replace(/[^a-z0-9._-]+/gi,'-');
export const pacificDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));

export function normalizedLimits(profile={}){
  const configured=Number(profile.rpm)>0&&Number(profile.tpm)>0&&Number(profile.rpd)>0;
  const rpm=Math.floor(Number(profile.rpm)>0?Number(profile.rpm):1);
  const tpm=Math.floor(Number(profile.tpm)>0?Number(profile.tpm):8_000);
  const rpd=Math.floor(Number(profile.rpd)>0?Number(profile.rpd):10);
  const reservePercent=clamp(profile.reservePercent||20,5,50);
  return{rpm,tpm,rpd,reservePercent,source:profile.source||(configured?'configured':'safe_default'),configured};
}

export function usableLimits(profile={}){
  const limits=normalizedLimits(profile);const ratio=(100-limits.reservePercent)/100;
  return{...limits,usableRpm:Math.max(1,Math.floor(limits.rpm*ratio)),usableTpm:Math.max(500,Math.floor(limits.tpm*ratio)),usableRpd:Math.max(1,Math.floor(limits.rpd*ratio))};
}

export function estimatedTokens(value){return Math.max(1,Math.ceil(String(value||'').length/4))}
export function compactBatches(items,{tokenBudget=8_000,maxRows=1_000,serialize=item=>String(item)}={}){
  const batches=[];let batch=[];let tokens=120;
  for(const item of items){const size=estimatedTokens(serialize(item))+3;if(batch.length&&(batch.length>=maxRows||tokens+size>tokenBudget)){batches.push(batch);batch=[];tokens=120}batch.push(item);tokens+=size}
  if(batch.length)batches.push(batch);return batches;
}

class QuotaGate{
  constructor(model,limits,ledger){this.model=model;this.limits=usableLimits(limits);this.ledger=ledger;this.dirty=false}
  refreshDay(){const day=pacificDay(Date.now());if(this.ledger?.day!==day)this.ledger={version:1,day,model:this.model,requests:0,inputTokens:0,outputTokens:0,totalTokens:0,events:[],updatedAt:new Date().toISOString()};this.ledger.events=(this.ledger.events||[]).filter(event=>Date.now()-Date.parse(event.at)<60_000)}
  ensureDaily(){this.refreshDay();if(Number(this.ledger.requests)>=this.limits.usableRpd)throw new GooglePauseError(`${this.model} đã gần giới hạn lượt dùng hôm nay. Queue đã được lưu để tự chạy tiếp vào ngày kế tiếp.`,{reason:'daily_quota',quota:{requestsPerMinute:this.limits.rpm,tokensPerMinute:this.limits.tpm,requestsPerDay:this.limits.rpd,reservePercent:this.limits.reservePercent}})}
  async reserve(inputTokens){
    this.refreshDay();const quota={requestsPerMinute:this.limits.rpm,tokensPerMinute:this.limits.tpm,requestsPerDay:this.limits.rpd,reservePercent:this.limits.reservePercent};
    if(inputTokens>=this.limits.usableTpm)throw new GooglePauseError(`Lô ${inputTokens.toLocaleString('vi-VN')} token vượt mức an toàn ${this.limits.usableTpm.toLocaleString('vi-VN')} token của ${this.model}.`,{reason:'batch_too_large',quota});
    while(true){
      this.refreshDay();
      if(Number(this.ledger.requests)>=this.limits.usableRpd)throw new GooglePauseError(`${this.model} đã gần giới hạn lượt dùng hôm nay. Queue đã được lưu để tự chạy tiếp vào ngày kế tiếp.`,{reason:'daily_quota',quota});
      const recentRequests=this.ledger.events.length;const recentTokens=this.ledger.events.reduce((sum,event)=>sum+(Number(event.inputTokens)||0),0);
      if(recentRequests<this.limits.usableRpm&&recentTokens+inputTokens<this.limits.usableTpm)break;
      const oldest=Math.min(...this.ledger.events.map(event=>Date.parse(event.at)));const wait=Math.max(1_000,oldest+60_500-Date.now());console.log(`${this.model}: gần giới hạn phút, tự chờ ${Math.ceil(wait/1000)} giây`);await sleep(wait);
    }
    const at=new Date().toISOString();this.ledger.events.push({at,inputTokens});this.ledger.requests=Number(this.ledger.requests||0)+1;this.ledger.inputTokens=Number(this.ledger.inputTokens||0)+inputTokens;this.ledger.totalTokens=Number(this.ledger.totalTokens||0)+inputTokens;this.ledger.updatedAt=at;this.dirty=true;
  }
  complete(usage){const output=Number(usage?.outputTokens)||0;this.ledger.outputTokens=Number(this.ledger.outputTokens||0)+output;this.ledger.totalTokens=Number(this.ledger.totalTokens||0)+output;this.ledger.updatedAt=new Date().toISOString();this.dirty=true}
  file(){return jsonFile(`usage/google/${this.ledger.day}/${safeName(this.model)}.json`,{...this.ledger,limits:this.limits})}
}

export class QuotaRouter{
  constructor(config,primary){this.config=config||{};this.models=[primary,...(this.config.fallbacks||[])].filter((item,index,list)=>item&&list.indexOf(item)===index);this.gates=new Map();this.extraFiles=[]}
  limitsFor(model){return usableLimits(this.config.limits?.[model]||{})}
  batchTokenBudget(){const limits=this.limitsFor(this.models[0]);return Math.max(500,Math.min(24_000,Math.floor(limits.usableTpm*.45)))}
  batchRowLimit(defaultRows=1_000){return Math.floor(clamp(this.config.batchRows||defaultRows,10,1_000))}
  async gate(model){if(this.gates.has(model))return this.gates.get(model);const day=pacificDay(Date.now());const [ledger,detected]=await Promise.all([readJson(`usage/google/${day}/${safeName(model)}.json`),readJson(`usage/google/limits/${safeName(model)}.json`)]);const saved=this.config.limits?.[model]||{};const profile={rpm:saved.rpm||detected?.rpm,tpm:saved.tpm||detected?.tpm,rpd:saved.rpd||detected?.rpd,reservePercent:saved.reservePercent||20,source:saved.source||detected?.source};const gate=new QuotaGate(model,profile,ledger);gate.refreshDay();this.gates.set(model,gate);return gate}
  files(){return[...this.gates.values()].filter(gate=>gate.dirty).map(gate=>gate.file()).concat(this.extraFiles)}
  async generate({prompt,temperature=.1,label='Google AI'}){
    let lastError;const startedAt=Date.now();const waitBudget=Math.floor(clamp(this.config.automaticWaitMinutes||12,1,25))*60_000;
    while(true){
      let mayRetry=false;
      for(const model of this.models){
        const gate=await this.gate(model);
        try{
          gate.ensureDaily();
          const inputTokens=await countGoogleTokens({prompt,model});
          await gate.reserve(inputTokens);
          // Persist the reservation before generation so a terminated runner cannot
          // forget an in-flight request and accidentally reuse the same quota.
          await uploadWithRetry([gate.file()]);
          gate.dirty=false;
          const response=await requestGoogle({prompt,temperature,label,model,attemptLimit:1});
          gate.complete(response.usage);
          return{...response,model,inputTokens,quota:gate.limits};
        }catch(error){
          lastError=error;
          error.model=model;
          if(error instanceof GooglePauseError&&error.status===429&&error.quota){const detected={model,rpm:Number(error.quota.requestsPerMinute)||null,tpm:Number(error.quota.tokensPerMinute)||null,rpd:Number(error.quota.requestsPerDay)||null,tokenPerDay:Number(error.quota.tokenPerDay)||null,source:'google_error',updatedAt:new Date().toISOString()};this.extraFiles=[jsonFile(`usage/google/limits/${safeName(model)}.json`,detected)]}
          if(error instanceof GooglePauseError&&['rate_limit','service_busy','network'].includes(error.reason)){mayRetry=true;const files=this.files();if(files.length)await uploadWithRetry(files);continue}
          if(error instanceof GooglePauseError&&error.reason==='daily_quota'){const files=this.files();if(files.length)await uploadWithRetry(files);continue}
          throw error;
        }
      }
      if(!mayRetry||Date.now()-startedAt>=waitBudget)throw lastError||new GooglePauseError('Không còn model dự phòng có quota khả dụng.',{reason:'daily_quota'});
      const wait=Math.min(65_000,Math.max(1_000,waitBudget-(Date.now()-startedAt)));console.log(`${label}: Google đang bận, tự chờ ${Math.ceil(wait/1000)} giây rồi thử lại`);await sleep(wait);
    }
  }
}

export async function createQuotaRouter({config,primary}){return new QuotaRouter(config,primary)}
