import type { Agent } from "../types";

export interface M1Participant {
  id: string;
  agentId?: string;
  name?: string;
  model?: string;
  objectiveId: string;
  handle: string;
  agent: "claude" | "codex"; // native harness, not Team agent
  role: string;
  workdir: string;
}
export interface M1Task {
  id: string;
  objective_id: string;
  title: string;
  description: string;
  status: string;
  owner?: string;
  summary?: string;
  revision: number;
}
export interface M1Message {seq: number; from: string; to?: string; body: string; created_at: string}
export interface M1TurnSummary {
  turnId:string;
  agentId?:string;
  name?:string;
  sessionId:string;
  participantId:string;
  handle:string;
  agent:string;
  role:string;
  trigger:string;
  state:string;
  startedAt:string;
  endedAt?:string;
  toolFailures:number;
  logPath:string;
  logSha256:string;
  usage:Array<{provider:string;model:string;uncachedInput:number|null;cacheRead:number|null;cacheWrite:number|null;output:number|null;costUsd:number|null;costKind:string}>;
}
export interface M1Snapshot {
  turns: M1TurnSummary[];
  objective: {id:string; title:string; description:string; acceptance_criteria:string; status:string; tasks:M1Task[]};
  participants: M1Participant[];
  messages: M1Message[];
}
export interface M1TurnReport {
  turnId: string;
  sessionId: string;
  participant: string;
  provider: string;
  state: string;
  finalText: string;
  nativeSessionId: string;
  toolFailures: number;
  usage: Array<{provider:string; uncached_input:number|null; cache_read:number|null; cache_write:number|null; output:number|null; cost_usd_estimate:number|null}>;
  evidencePath: string;
  evidenceSha256: string;
  diffPath?: string;
  diffSha256?: string;
  gitHead?: string;
  gitStatus?: string;
  gitEvidenceError?: string;
  error?: string;
}
export interface M1Creation {
  id:string;
  projectId:string;
  participants:M1Participant[];
  tasks:M1Task[];
}
export interface M1AgentSelection {
  id: string;
  name: string;
  handle: string;
  role: string;
  harness: Agent;
  model: string;
  knowledgeRoot: string;
  languages: string[];
  assigned: string[];
}
export interface M1CreateInput {
  repository:string;
  title:string;
  description:string;
  acceptanceCriteria:string;
  developer:M1AgentSelection;
  reviewer:M1AgentSelection;
  wakeBudget:number;
  tasks:string[];
}
interface M1Bridge {
  CreateM1Objective(req: M1CreateInput): Promise<M1Creation>;
  RunM1Turn(req: {participantId:string;prompt:string;knowledgeRoot:string;assigned:string[]}): Promise<M1TurnReport>;
  CancelM1Turn(participantID:string): Promise<void>;
  GetM1Snapshot(objectiveID:string): Promise<M1Snapshot>;
  PostM1Message(objectiveID:string,toHandle:string,body:string):Promise<M1Message>;
  SetM1Verdict(req:{objectiveId:string;taskId:string;expectedRevision:number;accepted:boolean;verificationEvidence:string;reviewEvidence:string;directorNote:string}):Promise<M1Task>;
}
const bridge = ():M1Bridge | undefined => (window as unknown as {go?:{main?:{M1Runtime?:M1Bridge}}}).go?.main?.M1Runtime;
function native():M1Bridge { const b=bridge();if(!b)throw Error("Use the native desktop app to run M1.");return b; }
export const m1 = {
  objectiveID: "",
  snapshot: null as M1Snapshot|null,
  reports: {} as Record<string,M1TurnReport>,
  running: "" as string,
  eventCount: 0,
  error: "",
  busy: false,
  repository: "",
  knowledgeRoot: "",
};
export async function restoreM1() {
  try {
    m1.objectiveID=localStorage.getItem("m1:objective")||"";
    m1.repository=localStorage.getItem("m1:repo")||"";
    m1.knowledgeRoot=localStorage.getItem("m1:knowledge")||"";
  } catch {/* local preferences optional */}
  if(m1.objectiveID && bridge())await refreshM1();
}
export async function refreshM1() {
  if(!m1.objectiveID)return;
  try{m1.snapshot=await native().GetM1Snapshot(m1.objectiveID);m1.error="";}
  catch(e){m1.error=String(e);m1.snapshot=null;}
}
export async function createM1(req:M1CreateInput) {
  m1.busy=true;m1.error="";
  try {
    const created=await native().CreateM1Objective(req);
    m1.objectiveID=created.id;m1.repository=req.repository;
    try{localStorage.setItem("m1:objective",created.id);localStorage.setItem("m1:repo",req.repository);}catch {/* optional */}
    await refreshM1();
  } catch(e){m1.error=String(e);}
  finally{m1.busy=false;}
}
export async function runM1(participantId:string,prompt:string,knowledgeRoot:string) {
  m1.running=participantId;m1.error="";m1.eventCount=0;m1.knowledgeRoot=knowledgeRoot;
  try{localStorage.setItem("m1:knowledge",knowledgeRoot);}catch{/* optional */}
  try{m1.reports[participantId]=await native().RunM1Turn({participantId,prompt,knowledgeRoot,assigned:[]});}
  catch(e){m1.error=String(e);}
  finally{m1.running="";await refreshM1();}
}
export async function cancelM1() {
  if(m1.running)await native().CancelM1Turn(m1.running);
}
export async function postM1Message(toHandle:string,body:string) {
  if(!m1.objectiveID)return;
  try{await native().PostM1Message(m1.objectiveID,toHandle,body);await refreshM1();}
  catch(e){m1.error=String(e);}
}
export async function verdictM1(req:{taskId:string;expectedRevision:number;accepted:boolean;verificationEvidence:string;reviewEvidence:string;directorNote:string}) {
  if(!m1.objectiveID)return;
  try{await native().SetM1Verdict({objectiveId:m1.objectiveID,...req});await refreshM1();}
  catch(e){m1.error=String(e);}
}
export function subscribeM1Events(onChange:()=>void) {
  const runtime=(window as unknown as {runtime?:{EventsOn(event:string,cb:(data:{participantId:string;type:string;seq:number})=>void):void}}).runtime;
  runtime?.EventsOn("m1-native-event",event=>{if(m1.running===event.participantId){m1.eventCount++;onChange();}});
}
