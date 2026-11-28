// File-first source adapter. GitHub is cloned through the user's native Git credentials.
// No MCP, network requests from the frontend, or model calls are required.
export interface KnowledgeEntry {
 id:string; title?:string; description?:string; path:string; kind:string; load?:string; status?:string; roles?:string[]; languages?:string[]; sha256?:string; bytes:number; tokens:number;
}
export interface KnowledgePack {
 schemaVersion:number; id:string; version:string; status:string; language:string;
 entries:KnowledgeEntry[]; root:string; ref:string; repository?:string; manifest?:string;
}
type Bridge={go?:{main?:{KnowledgeSource?:{
 SyncGitHub(ref:string):Promise<KnowledgePack>;
 SyncRepository(repository:string,ref:string,manifest:string):Promise<KnowledgePack>;
 ListGitRefs(repository:string):Promise<Array<{name:string;kind:string}>>;
 ImportJSON(raw:string):Promise<KnowledgePack>;
 LoadLocal(path:string):Promise<KnowledgePack>;
 ReadEntry(root:string,id:string):Promise<string>;
}}}};
const native=()=>(window as unknown as Bridge).go?.main?.KnowledgeSource;
export const knowledgeAvailable=()=>Boolean(native());
const needsRestart=()=>new Error("Native knowledge adapter is outdated. Stop the app, run wails dev again, then retry.");
export async function syncKnowledge(repository:string, selectedRef=""):Promise<KnowledgePack> {
 const adapter=native();
 if(!adapter?.SyncRepository)throw needsRestart();
 return adapter.SyncRepository(repository,selectedRef,"manifest.json");
}
export async function listKnowledgeRefs(repository:string):Promise<Array<{name:string;kind:string}>> {
 const adapter=native();
 if(!adapter?.ListGitRefs)throw needsRestart();
 return adapter.ListGitRefs(repository);
}
export async function importKnowledgeJSON(raw:string):Promise<KnowledgePack> {
 const adapter=native();
 if(!adapter?.ImportJSON)throw needsRestart();
 return adapter.ImportJSON(raw);
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
export function knowledgeApplicable(e:KnowledgeEntry,role:string,languages:string[]):boolean {
 const roles=e.roles?.map(v=>v.toLowerCase())??[];
 const langs=e.languages?.map(v=>v.toLowerCase())??[];
 return (!roles.length||roles.includes(role.toLowerCase())) && (!langs.length||languages.some(l=>langs.includes(l.toLowerCase())));
}
export const knowledgePhase=(e:KnowledgeEntry):number=>{
 if(e.kind==="engineering"||e.kind==="roles")return 1;
 if(e.id.includes("testing")||e.id.includes("code-review"))return 6;
 if(e.id.includes("debugging"))return 5;
 if(e.kind==="references"||e.kind==="guides")return 4;
 return 3;
};
// Manifest metadata is authoritative. Bootstrap applies by role and language;
// on-demand material is included only when explicitly assigned to the agent.
export function knowledgeForAgent(pack:KnowledgePack|undefined,role:string,assigned:string[],languages:string[]=[]):KnowledgeEntry[]{
 if(!pack)return [];
 const selected=new Set(assigned);
 return pack.entries.filter(e=>knowledgeApplicable(e,role,languages)&&(e.load==="bootstrap"||selected.has(e.id)));
}
