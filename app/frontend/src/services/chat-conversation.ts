export interface ChatMessage {author:string;body:string}
export interface ChatConversation {messages:ChatMessage[];error:string}
export function freshConversation():ChatConversation{return {messages:[],error:""}}
