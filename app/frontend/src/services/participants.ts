import type { Agent } from "../types";
// Temporary participants; agent identity and harness identity are separate.
export interface Participant { id:string; name:string; handle:string; harness:Agent; role?:string }
export const participants:Participant[]=[
 {id:"claude-default",name:"Claude",handle:"claude",harness:"Claude"},
 {id:"codex-default",name:"Codex",handle:"codex",harness:"Codex"}
];
export function mentionedParticipants(message:string){
 const handles=new Set(Array.from(message.matchAll(/(?:^|\s)@([\w-]+)/g),m=>m[1].toLowerCase()));
 const selected=participants.filter(p=>handles.has(p.handle));
 return selected.length?selected:participants;
}
