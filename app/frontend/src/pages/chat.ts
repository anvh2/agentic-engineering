import type { ViewContext } from "../view-context";
import { renderConsole } from "../components/harness-console";
export function renderChat(ctx:ViewContext):string {
 return renderConsole(ctx.nav.detail==="Claude"?"Claude":"Codex",ctx);
}
