export interface ChatMessage {author:string;body:string;logs?:string[]}
export interface ChatConversation {messages:ChatMessage[];error:string}
export function freshConversation():ChatConversation{return {messages:[],error:""}}
