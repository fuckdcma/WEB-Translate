const retryableStatuses=new Set([408,429,500,502,503,504]);
const configuredMaxAttempts=Math.min(4,Math.max(1,Number(process.env.GEMINI_MAX_ATTEMPTS)||2));

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

export class GoogleResponseError extends Error{
  constructor(message,{reason='invalid_response',finishReason='',responseChars=0}={}){
    super(message);
    this.name='GoogleResponseError';
    this.reason=reason;
    this.finishReason=finishReason;
    this.responseChars=responseChars;
  }
}

export function assertCompleteGooglePayload(payload,label='Google AI'){
  const candidate=payload?.candidates?.[0];
  const finishReason=String(candidate?.finishReason||'');
  const responseChars=String(candidate?.content?.parts?.[0]?.text||'').length;
  if(finishReason==='MAX_TOKENS')throw new GoogleResponseError(`${label}: câu trả lời bị cắt vì vượt giới hạn đầu ra; hệ thống sẽ chia lô nhỏ hơn.`,{reason:'output_limit',finishReason,responseChars});
  if(finishReason&&finishReason!=='STOP')throw new GoogleResponseError(`${label}: Google dừng phản hồi với lý do ${finishReason}. Tiến độ đã được lưu.`,{reason:'invalid_response',finishReason,responseChars});
}

function isDailyQuota(detail){return /daily|per[ _-]?day|requests?[ _-]?per[ _-]?day|\brpd\b|GenerateRequestsPerDay/i.test(detail)}
export function quotaInfo(detail){try{const payload=typeof detail==='string'?JSON.parse(detail):detail;const entries=(payload?.error?.details||[]).flatMap(item=>item.violations||[]);const result={};for(const item of entries){const text=`${item.quotaMetric||''} ${item.quotaId||''} ${item.description||''}`;const value=Number(item.quotaValue||String(item.description||'').match(/(?:limit|quota)[^\d]*(\d[\d,]*)/i)?.[1]?.replace(/,/g,''));if(!Number.isFinite(value))continue;if(/token.*day|TokensPerDay|\bTPD\b/i.test(text))result.tokenPerDay=value;else if(/request.*day|RequestsPerDay|\bRPD\b/i.test(text))result.requestsPerDay=value;else if(/token.*minute|TokensPerMinute|\bTPM\b/i.test(text))result.tokensPerMinute=value;else if(/request.*minute|RequestsPerMinute|\bRPM\b/i.test(text))result.requestsPerMinute=value}return Object.keys(result).length?result:null}catch{return null}}
function usageInfo(payload){const usage=payload?.usageMetadata||{};return{inputTokens:Number(usage.promptTokenCount)||0,outputTokens:(Number(usage.candidatesTokenCount)||0)+(Number(usage.thoughtsTokenCount)||0),totalTokens:Number(usage.totalTokenCount)||0,requests:1}}

function retryDelay(response,attempt){
  const retryAfterSeconds=Number(response?.headers?.get('retry-after'));
  if(Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0)return Math.min(60_000,retryAfterSeconds*1000);
  return Math.min(60_000,2_000*2**(attempt-1))+Math.round(Math.random()*1_500);
}

export async function countGoogleTokens({prompt,model=process.env.GEMINI_MODEL||'gemini-3.6-flash'}){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`;
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}]}),signal:AbortSignal.timeout(60_000)});
  if(response.ok)return Number((await response.json()).totalTokens)||0;
  const detail=await response.text();
  throw new GooglePauseError(`Không thể kiểm tra token cho ${model}. Tiến độ đã được lưu.`,{reason:response.status===429?'rate_limit':'token_count',status:response.status,quota:quotaInfo(detail)});
}

export async function requestGoogle({prompt,temperature=0.1,label='Google AI',model=process.env.GEMINI_MODEL||'gemini-3.6-flash',attemptLimit=configuredMaxAttempts,beforeAttempt=null,maxOutputTokens=32_768}){
  const googleUrl=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const maxAttempts=Math.min(configuredMaxAttempts,Math.max(1,Number(attemptLimit)||1));
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    if(beforeAttempt)await beforeAttempt(attempt);
    let response;
    try{
      response=await fetch(googleUrl,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{candidateCount:1,responseMimeType:'application/json',temperature,maxOutputTokens}}),signal:AbortSignal.timeout(300_000)});
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
