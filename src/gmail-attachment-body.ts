export const MAX_GMAIL_ATTACHMENT = 20 * 1024 * 1024;

/** Decode only the bounded MessagePartBody envelope used by attachments.get.
 * Large base64 data is decoded in small pieces, never materialized as one string.
 * Unknown response shapes fail closed so an API change cannot silently alter bytes.
 */
export async function readAttachmentBody(response:Response,expected:number):Promise<Uint8Array<ArrayBuffer>> {
  if(!response.ok||!response.body||!Number.isSafeInteger(expected)||expected<0||expected>MAX_GMAIL_ATTACHMENT)throw new Error('Attachment unavailable');
  const limit=Math.ceil(expected/3)*4+8192;
  if(Number(response.headers.get('content-length')||0)>limit){await response.body.cancel();throw new Error('Attachment response too large');}
  const output=new Uint8Array(new ArrayBuffer(expected));
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let received=0,written=0,envelope='',key='',tail='',escaped=false;
  let state:string='start';
  const seen=new Set<string>();
  const fail=()=>{throw new Error('Invalid attachment response');};
  function decode(value:string,final=false){
    if(!/^[A-Za-z0-9_=-]*$/.test(value))fail();
    const combined=tail+value;
    const n=final?combined.length:Math.max(0,Math.floor((combined.length-4)/4)*4);
    const part=combined.slice(0,n);tail=combined.slice(n);
    if(!part)return;
    if(final){if(!/^[A-Za-z0-9_-]*={0,2}$/.test(part)||part.replace(/=+$/,'').length%4===1)fail();}
    else if(part.includes('='))fail();
    const raw=atob(part.replace(/-/g,'+').replace(/_/g,'/'));
    if(final&&btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==part.replace(/=+$/,''))fail();
    if(written+raw.length>expected)fail();
    for(let i=0;i<raw.length;i++)output[written++]=raw.charCodeAt(i);
  }
  function consume(text:string){
    for(let i=0;i<text.length;i++){
      if(state==='data'){
        const end=text.indexOf('"',i);
        decode(text.slice(i,end<0?text.length:end),end>=0);
        if(end<0)return;
        envelope+='"';state='after';i=end;continue;
      }
      const c=text[i];envelope+=c;if(envelope.length>8192)fail();
      if(state==='key'){
        if(c==='"'){if(!['size','data','attachmentId'].includes(key)||seen.has(key))fail();seen.add(key);state='colon';}
        else {if(!/[A-Za-z]/.test(c))fail();key+=c;}
        continue;
      }
      if(state==='string'){
        if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')state='after';
        continue;
      }
      if(state==='number'&&/[0-9]/.test(c))continue;
      if(state==='number')state='after';
      if(/[\t\n\r ]/.test(c))continue;
      if(state==='start'&&c==='{'){state='keyOrEnd';continue;}
      if((state==='keyOrEnd'||state==='keyRequired')&&c==='"'){key='';state='key';continue;}
      if(state==='keyOrEnd'&&c==='}'){state='end';continue;}
      if(state==='colon'&&c===':'){state='value';continue;}
      if(state==='value'){
        if(key==='size'&&/[0-9]/.test(c)){state='number';continue;}
        if(key==='data'&&c==='"'){state='data';continue;}
        if(key==='attachmentId'&&c==='"'){state='string';continue;}
      }
      if(state==='after'&&c===','){state='keyRequired';continue;}
      if(state==='after'&&c==='}'){state='end';continue;}
      fail();
    }
  }
  try{
    for(;;){
      const chunk=await reader.read();if(chunk.done)break;
      received+=chunk.value.byteLength;if(received>limit)throw new Error('Attachment response too large');
      for(let i=0;i<chunk.value.length;i+=32768)consume(decoder.decode(chunk.value.subarray(i,i+32768),{stream:true}));
    }
    consume(decoder.decode());
    if(state!=='end'||!seen.has('data')||!seen.has('size')||written!==expected)fail();
    const metadata=JSON.parse(envelope) as {size:unknown};
    if(metadata.size!==expected)fail();
    return output;
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}
