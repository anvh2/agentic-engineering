import {createRoot,type Root} from "react-dom/client";
import {flushSync} from "react-dom";
import {Work} from "./Work";
import type {ViewContext} from "../view-context";
let active:Root|undefined;
export function unmountWork(){if(active){active.unmount();active=undefined}}
export function mountWork(node:HTMLElement,ctx:ViewContext){active=createRoot(node);flushSync(()=>active!.render(<Work ctx={ctx}/>))}
