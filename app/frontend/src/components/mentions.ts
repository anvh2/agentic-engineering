import { participants } from "../services/participants";
import { escapeHTML } from "./primitives";
export function mountMentions(root:HTMLElement){
 let selected=0;
 const field=()=>root.querySelector<HTMLTextAreaElement>("#group-prompt, #issue-chat-prompt");
 const menu=()=>root.querySelector<HTMLElement>("#mention-menu");
 const match=()=>{const f=field();return f?.value.slice(0,f.selectionStart).match(/(?:^|\s)@([\w-]*)$/)};
 const choices=()=>{const m=match();return m?participants.filter(p=>p.handle.startsWith(m[1].toLowerCase())):[]};
 const hide=()=>{const m=menu();if(m)m.hidden=true};
 const show=()=>{const m=menu(),items=choices();if(!m)return;if(!items.length){hide();return}selected=Math.min(selected,items.length-1);m.hidden=false;m.innerHTML='<small>Mention an agent</small>'+items.map((p,i)=>'<button type="button" data-mention="'+escapeHTML(p.handle)+'" class="'+(i===selected?'selected':'')+'"><span class="group-avatar '+p.harness.toLowerCase()+'">'+escapeHTML(p.name[0])+'</span><span>'+escapeHTML(p.name)+'<small>@'+escapeHTML(p.handle)+(p.role?' · '+escapeHTML(p.role):'')+'</small></span></button>').join("")};
 const insert=(handle:string)=>{const f=field(),m=match();if(!f||!m)return;const end=f.selectionStart,start=end-m[1].length-1;f.setRangeText("@"+handle+" ",start,end,"end");f.dispatchEvent(new Event("input",{bubbles:true}));f.focus();hide()};
 root.addEventListener("input",e=>{if(e.target===field()){selected=0;show()}});
 root.addEventListener("click",e=>{if(!(e.target instanceof Element))return;const button=e.target.closest<HTMLElement>("[data-mention]");if(button){insert(button.dataset.mention!);return}if(e.target===field())show();else if(!menu()?.contains(e.target))hide()});
 root.addEventListener("keydown",e=>{if(e.target!==field()||menu()?.hidden!==false||e.isComposing)return;const items=choices();if(!items.length)return;if(e.key==="Escape"){e.preventDefault();hide()}else if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();selected=(selected+(e.key==="ArrowDown"?1:items.length-1))%items.length;show()}else if(e.key==="Enter"&&!e.shiftKey||e.key==="Tab"){e.preventDefault();e.stopImmediatePropagation();insert(items[selected].handle)}},true);
}
