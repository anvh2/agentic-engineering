// File-first source adapter. GitHub is cloned through the user's native Git credentials.
// No MCP, network requests from the frontend, or model calls are required.
export interface KnowledgeEntry {
 id:string; title?:string; description?:string; path:string; kind:string; load?:string; bytes:number; tokens:number;
}
export interface KnowledgePack {
 schemaVersion:number; id:string; version:string; status:string; language:string;
 entries:KnowledgeEntry[]; root:string; ref:string;
}
type Bridge={go?:{main?:{KnowledgeSource?:{
 SyncGitHub(ref:string):Promise<KnowledgePack>;
 LoadLocal(path:string):Promise<KnowledgePack>;
 ReadEntry(root:string,id:string):Promise<string>;
}}}};
const native=()=>(window as unknown as Bridge).go?.main?.KnowledgeSource;
export const knowledgeAvailable=()=>Boolean(native());
export async function syncKnowledge(ref:string):Promise<KnowledgePack> {
 const adapter=native();if(!adapter)throw new Error("Open the Wails desktop app to connect a knowledge repository.");
 return adapter.SyncGitHub(ref);
}
export async function loadKnowledgeDirectory(path:string):Promise<KnowledgePack> {
 const adapter=native();if(!adapter)throw new Error("Open the Wails desktop app to open local knowledge.");
 return adapter.LoadLocal(path);
}
export async function readKnowledgeEntry(pack:KnowledgePack,id:string):Promise<string> {
 const adapter=native();if(!adapter)throw new Error("Native file adapter is unavailable.");
 return adapter.ReadEntry(pack.root,id);
}
export const knowledgeRoleName=(e:KnowledgeEntry):string=> (e.path.split("/").slice(-2,-1)[0]||e.id).replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase());
export const knowledgeDisplayName=(e:KnowledgeEntry):string=>{
 if(e.title?.trim())return e.title.trim();
 if(e.kind==="engineering")return "Engineering DNA";
 const name=e.path.split("/").pop()||e.id;
 if(e.kind==="roles")return e.path.split("/").slice(-2,-1)[0]?.replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase())||name;
 if(e.kind==="skills"||e.kind==="standards")return (e.path.split("/").slice(-2,-1)[0]||name).split("-").map(s=>s==="go"?"Go":s.charAt(0).toUpperCase()+s.slice(1)).join(" ");
 const humanize=(v:string)=>v.replace(/\.md$/i,"").replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase());
 const parent=e.path.split("/").slice(-2,-1)[0]||"";
 if(e.kind==="references")return humanize(parent)+" Reference";
 if(e.kind==="guides")return /^readme\.md$/i.test(name)?humanize(parent)+" Guide":humanize(name.replace(/^\d+-/,""));
 return humanize(name);
};
export const knowledgePhase=(e:KnowledgeEntry):number=>{
 if(e.kind==="engineering"||e.kind==="roles")return 1;
 if(e.id.includes("testing")||e.id.includes("code-review"))return 6;
 if(e.id.includes("debugging"))return 5;
 if(e.kind==="references"||e.kind==="guides")return 4;
 return 3;
};
// Only workspace DNA, this agent's role and its explicit selections are eligible.
export function knowledgeForAgent(pack:KnowledgePack|undefined,role:string,assigned:string[]):KnowledgeEntry[]{
 if(!pack)return [];
 const roleSlug=role.toLowerCase().replace(/\s+/g,"-");
 const included=new Set(assigned);
 return pack.entries.filter(e=>e.kind==="engineering" ||
   e.kind==="roles" && e.path.includes("/roles/"+roleSlug+"/") ||
   e.kind!=="roles" && included.has(e.id));
}
