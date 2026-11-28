import type { KnowledgePack } from "./services/knowledge-source";
export type Agent = "Claude" | "Codex";
export interface Project { id: string; name: string; description: string; repos: string[]; knowledge: Record<string,string> }
export interface Repository { id: string; name: string; path: string }
export interface Task { text: string; done: boolean }
export interface Objective { id: string; project: string; title: string; description: string; criteria: string; status: string; repos: string[]; assignments: Record<Agent,string>; tasks: Task[] }
export interface Session { id: string; objective: string; agent: string; role: string; task: string; status: string; tokens: number; cost: number; context: string }
export interface AppState { agentKnowledge?: Record<string,string[]>; knowledgePack?: KnowledgePack; projects: Project[]; repos: Repository[]; roles: Record<string,string>; knowledge: Record<string,string>; objectives: Objective[]; sessions: Session[]; messages: {objective:string;agent:string;body:string}[]; decisions: {id:string;objective:string;name:string;reason:string;status:string}[]; settings:{budget:number;approval:boolean} }
