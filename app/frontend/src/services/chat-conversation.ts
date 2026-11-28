export type ChatBlock = {kind:"text";text:string}|{kind:"tool";id:string;label:string;status:string;output:string};
export interface ChatMessage {author:string;body:string;blocks?:ChatBlock[]}
export interface ChatConversation {messages:ChatMessage[];error:string}
export function freshConversation():ChatConversation{return {messages:[],error:""}}
