type UploadFile = File & {webkitRelativePath:string};
type Request = <T>(url:string,body?:unknown,method?:string)=>Promise<T>;
export async function importFolder(files:UploadFile[],parent:string,api:Request,onProgress:(text:string)=>void) {
  if(!files.length)return {saved:0,errors:[] as string[]};
  if(files.length>2000)throw new Error('Select a smaller folder, up to 2,000 files per batch.');
  const folders=new Map<string,string>([['',parent]]);
  let saved=0;const errors:string[]=[];
  for(const file of files) {
    const path=file.webkitRelativePath || file.name;
    const parts=path.split('/');
    try {
      if(parts.length>99 || parts.some(p=>!p||p==='.'||p==='..'||p.length>255||/[\\\u0000-\u001f]/.test(p)))throw new Error('Unsupported folder path.');
      if(file.size>20*1024*1024)throw new Error('File exceeds 20 MiB.');
      onProgress(`${saved+errors.length+1}/${files.length}: ${path}`);
      let current=parent,prefix='';
      for(const name of parts.slice(0,-1)) {
        prefix=prefix?`${prefix}/${name}`:name;
        const known=folders.get(prefix);
        if(known){current=known;continue;}
        try {
          const result=await api<{entry:{id:string}}>('/api/folders',{parentId:current,name});
          current=result.entry.id;
        } catch(error) {
          if((error as {status?:number}).status!==409)throw error;
          let offset:number|null=0,found:string|undefined;
          do {
            const listing:{entries:{id:string;name:string;kind:string}[];nextOffset:number|null}=await api(`/api/entries?parent=${encodeURIComponent(current)}&offset=${offset}`);
            found=listing.entries.find(e=>e.name===name&&e.kind==='folder')?.id;
            offset=listing.nextOffset;
          } while(!found && offset!==null);
          if(!found)throw new Error('A file conflicts with this folder name.');
          current=found;
        }
        folders.set(prefix,current);
      }
      const upload=await api<{url:string}>('/api/uploads',{parentId:current,name:file.name,size:file.size,mime:file.type || 'application/octet-stream'});
      const response=await fetch(upload.url,{method:'PUT',body:file,signal:AbortSignal.timeout(180000)});
      if(!response.ok){const body=await response.json() as {error?:string};throw new Error(body.error || 'Upload failed.');}
      saved++;
    } catch(error) {errors.push(`${path}: ${error instanceof Error?error.message:'Upload failed.'}`);}
  }
  return {saved,errors};
}
