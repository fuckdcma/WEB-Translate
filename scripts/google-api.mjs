const retryableStatuses=new Set([408,429,500,502,503,504]);
const maxAttempts=Math.min(4,Math.max(1,Number(process.env.GEMINI_MAX_ATTEMPTS)||4));

export const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

export class GooglePauseError extends Error{
  constructor(message,{reason='service_busy',attempts=1,status=0,quota=null}={}){
    super(message);
    this.name='GooglePauseError';
    this.reason=reason;
    this.attempts=attempts;
    this.status=status;
    this.quota=quota;
  }
}

function isDailyQuota(detail){return /daily|per[ _-]?day|requests?[ _-]?per[ _-]?day|\brpd\b|GenerateRequestsPerDay/i.test(detail)}
function quotaInfo(detail){try{const payload=JSON.parse(detail);const entries=(payload?.error?.details||[]).flatMap(item=>item.violations||[]);const result={};for(const item of entries){const text=`${item.quotaMetric||''} ${item.quotaId||''} ${item.description||''}`;const value=Number(item.quotaValue||String(item.description||'').match(/(?:limit|quota)[^\d]*(\d[\d,]*)/i)?.[1]?.replace(/,/g,''));if(!Number.isFinite(value))continue;if(/token.*day|TokensPerDay|\bTPD\b/i.test(text))result.tokenPerDay=value;else if(/request.*day|RequestsPerDay|\bRPD\b/i.test(text))result.requestsPerDay=value;else if(/token.*minute|TokensPerMinute|\bTPM\b/i.test(text))result.tokensPerMinute=value;else if(/request.*minute|RequestsPerMinute|\bRPM\b/i.test(text))result.requestsPerMinute=value}return Object.keys(result).length?result:null}catch{return null}}
function usageInfo(payload){const usage=payload?.usageMetadata||{};return{inputTokens:Number(usage.promptTokenCount)||0,outputTokens:(Number(usage.candidatesTokenCount)||0)+(Number(usage.thoughtsTokenCount)||0),totalTokens:Number(usage.totalTokenCount)||0,requests:1}}

function retryDelay(response,attempt){
  const retryAfterSeconds=Number(response?.headers?.get('retry-after'));
  if(Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0)return Math.min(60_000,retryAfterSeconds*1000);
  return Math.min(60_000,2_000*2**(attempt-1))+Math.round(Math.random()*1_500);
}

export async function requestGoogle({prompt,temperature=0.1,label='Google AI',model=process.env.GEMINI_MODEL||'gemini-3.6-flash'}){
  const googleUrl=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    let response;
    try{
      response=await fetch(googleUrl,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{candidateCount:1,responseMimeType:'application/json',temperature,maxOutputTokens:65_536}}),signal:AbortSignal.timeout(300_000)});
    }catch(error){
      if(attempt===maxAttempts)throw new GooglePauseError(`${label} tạm thời mất kết nối. Tiến độ đã được lưu.`,{reason:'network',attempts:attempt});
      const delay=retryDelay(null,attempt);
      console.warn(`${label}: lỗi kết nối, chờ ${delay}ms trước lần thử ${attempt+1}/${maxAttempts}`);
      await sleep(delay);
      continue;
    }

    if(response.ok){const payload=await response.json();return{payload,attempts:attempt,usage:usageInfo(payload)}}
    const detail=await response.text();
    const quota=quotaInfo(detail);
    if(response.status===429&&isDailyQuota(detail))throw new GooglePauseError(`${label} đã chạm giới hạn lượt dùng hôm nay. Hệ thống sẽ tự chạy tiếp sau khi giới hạn được làm mới.`,{reason:'daily_quota',attempts:attempt,status:429,quota});
    if(!retryableStatuses.has(response.status))throw new Error(`${label} request failed: ${response.status} ${detail}`);
    if(attempt===maxAttempts)throw new GooglePauseError(`${label} đang bận. Tiến độ đã được lưu để tự chạy tiếp.`,{reason:response.status===429?'rate_limit':'service_busy',attempts:attempt,status:response.status,quota});
    const delay=retryDelay(response,attempt);
    console.warn(`${label}: nhận mã ${response.status}, chờ ${delay}ms trước lần thử ${attempt+1}/${maxAttempts}`);
    await sleep(delay);
  }
  throw new GooglePauseError(`${label} đang bận. Tiến độ đã được lưu để chạy tiếp.`);
}

export function makeBatches(items,serialize,{maxRows=1_000,maxChars=160_000}={}){
  const batches=[];
  let batch=[];
  let chars=0;
  for(const item of items){
    const itemChars=JSON.stringify(serialize(item)).length+1;
    if(batch.length&&(batch.length>=maxRows||chars+itemChars>maxChars)){batches.push(batch);batch=[];chars=0}
    batch.push(item);
    chars+=itemChars;
  }
  if(batch.length)batches.push(batch);
  return batches;
}
