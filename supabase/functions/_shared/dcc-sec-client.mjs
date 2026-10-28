const CAP=64*1024*1024;
export class SharedSecError extends Error {
 constructor(code,message,status,retryAfter){super(message);this.name='SharedSecError';this.code=code;this.status=this.httpStatus=status;this.retryAfter=retryAfter;this.headers=retryAfter==null?{}:{'retry-after':String(retryAfter)};}
}
export async function fetchSec(url,options){
 const {baseUrl,token,maxBytes=CAP,timeoutMs=25000,ttlSeconds=300,refresh=false,signal}=options;
 let origin;
 try{origin=new URL(baseUrl);}catch{throw new SharedSecError('configuration_error','Shared SEC service URL is missing.');}
 if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!(origin.protocol==='https:'||origin.protocol==='http:'&&origin.hostname==='127.0.0.1')||!/^[-\w]{32,128}$/.test(token??''))throw new SharedSecError('configuration_error','SEC service requires loopback HTTP or remote HTTPS and a valid token.');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>CAP||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new SharedSecError('invalid_request','SEC response or time bound is invalid.');
 const timeout=AbortSignal.timeout(Math.min(30000,Math.ceil(timeoutMs)+5000));
 const abort=signal?AbortSignal.any([signal,timeout]):timeout;
 let response;
 try{response=await fetch(new URL('/v1/fetch',origin),{method:'POST',redirect:'error',signal:abort,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({url,max_bytes:maxBytes,timeout_seconds:Math.max(1,Math.min(25,Math.ceil(timeoutMs/1000))),ttl_seconds:ttlSeconds,refresh})});}
 catch(error){if(signal?.aborted)throw signal.reason;throw new SharedSecError('service_unavailable','Shared SEC service is unavailable; retained evidence remains unchanged.');}
 const reader=response.body?.getReader();const chunks=[];let size=0;const bound=response.ok?maxBytes*2+32768:16384;
 if(!reader)throw new SharedSecError('integrity_error','Shared SEC service returned no response.');
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>bound){await reader.cancel();throw new SharedSecError('response_too_large','Shared SEC response exceeds its bound.');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new SharedSecError('integrity_error','Shared SEC response is malformed.');}
 if(!response.ok){const error=data.error??{};throw new SharedSecError(error.code??'service_unavailable',error.message??'Shared SEC request failed.',error.http_status??response.status,error.retry_after);}
 let body;
 try{const decoded=atob(data.body_base64);body=Uint8Array.from(decoded,c=>c.charCodeAt(0));}catch{throw new SharedSecError('integrity_error','Shared SEC content encoding is invalid.');}
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),b=>b.toString(16).padStart(2,'0')).join('');
 if(data.schema_version!=='dcc-sec.response.v1'||data.url!==url||digest!==data.sha256||body.length>maxBytes||!['network','cache','replay'].includes(data.delivery)||![200,304].includes(data.status)||!/^[-a-f0-9]{16,64}$/.test(data.receipt_id)||['requested_at','retrieved_at','completed_at'].some(k=>typeof data[k]!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(data[k])||!Number.isFinite(Date.parse(data[k]))))throw new SharedSecError('integrity_error','Shared SEC response identity, timestamps or bytes are invalid.');
 return {body,url:data.url,sha256:data.sha256,retrievedAt:data.retrieved_at,completedAt:data.completed_at,requestedAt:data.requested_at,status:data.status,delivery:data.delivery,receiptId:data.receipt_id,headers:data.headers};
}
