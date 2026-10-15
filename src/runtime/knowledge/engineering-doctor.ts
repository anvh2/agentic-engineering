/**
 * Read-only diagnostics for installed engineering capabilities.
 * No provider calls, secrets, process introspection, hook installation or DB mutations.
 */
import { EngineeringKnowledgeCatalog, type KnowledgeEntry } from './engineering-knowledge.ts';
import { summarizeTrials, type Trial } from './engineering-eval.ts';

export type DoctorFinding=Readonly<{code:string;level:'error'|'warning'|'info';detail:string}>;
export function diagnoseEngineeringSetup(input:{
 entries:readonly KnowledgeEntry[]; trials:readonly Trial[];
 configuredAdapters:readonly string[]; hooksEnabled:boolean;
}):readonly DoctorFinding[] {
 const findings:DoctorFinding[]=[];
 let catalog:EngineeringKnowledgeCatalog|undefined;
 try{ catalog=new EngineeringKnowledgeCatalog(input.entries); }
 catch(e){findings.push({code:'invalid_catalog',level:'error',detail:String(e)});}
 if(catalog){
  const available=input.entries.filter(e=>e.approved);
  if(available.length===0)findings.push({code:'no_approved_knowledge',level:'warning',detail:'No approved skills; task behavior remains unchanged.'});
  else findings.push({code:'catalog_digest',level:'info',detail:catalog.catalogDigest});
 }
 for(const name of input.configuredAdapters){
  if(!['go','js','ts'].includes(name))findings.push({code:'unknown_adapter',level:'error',detail:name});
  if(name==='ts')findings.push({code:'ts_disabled',level:'warning',detail:'TypeScript delegation remains disabled in language-adapter policy.'});
 }
 try{
   const scores=summarizeTrials(input.trials);
   if(!scores.length)findings.push({code:'no_eval_evidence',level:'warning',detail:'Provider selection must not claim benchmark superiority.'});
 }catch(e){findings.push({code:'invalid_eval_evidence',level:'error',detail:String(e)});}
 if(input.hooksEnabled)findings.push({code:'hooks_unverified',level:'warning',detail:'Installed hooks require separate runtime security audit.'});
 return Object.freeze(findings);
}
export interface EngineeringStatusSnapshot {
  catalogDigest:string|null;
  approvedEntries:number;
  candidateEntries:number;
  providersWithEvidence:number;
  issues:readonly DoctorFinding[];
}
export function engineeringStatus(input:Parameters<typeof diagnoseEngineeringSetup>[0]):EngineeringStatusSnapshot{
 const issues=diagnoseEngineeringSetup(input);
 let digest:string|null=null;
 try{digest=new EngineeringKnowledgeCatalog(input.entries).catalogDigest;}catch{}
 let providers=0;
 try{providers=summarizeTrials(input.trials).length;}catch{}
 return Object.freeze({
  catalogDigest:digest,approvedEntries:input.entries.filter(e=>e.approved).length,
  candidateEntries:input.entries.filter(e=>!e.approved).length,
  providersWithEvidence:providers,issues,
 });
}
