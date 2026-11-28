import {renderChatView} from "../components/chat-view";
import {renderChatComposer} from "../components/chat-composer";
import type { ViewContext } from "../view-context";
import { escapeHTML } from "../components/primitives";
import { group } from "../services/collaboration";
import { consoles } from "../services/harness-console";
export function renderCollaboration(_ctx:ViewContext):string{return renderChatView({title:"Project Chat",subtitle:"You · Claude · Codex",messages:group.messages,live:group.active.map(agent=>({agent,body:consoles[agent].output,activity:consoles[agent].activity})),error:group.error,welcome:'<div class="chat-welcome"><h2>Start a conversation</h2><p>Introduce Claude and Codex to each other.</p><button data-group-start>Say hello</button></div>',composer:renderChatComposer({id:"group-prompt",placeholder:"Message everyone, @claude or @codex…",draft:group.draft,running:group.busy,send:"data-group-send",stop:"data-group-stop",toolbar:"<small>Claude + Codex</small>",mentions:true,hint:"Parallel discussion · Short replies · One round per message"})})}
