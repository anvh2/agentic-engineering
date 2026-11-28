import { renderChat } from "./chat";
import { renderM1 } from "./m1";
import { renderOverview } from "./overview";
import { renderProjects } from "./projects";
import { renderCollaboration } from "./collaboration";
import { renderSessions } from "./sessions";
import { renderDecisions } from "./decisions";
import { renderEngineeringDNA } from "./engineering-dna";
import { renderTeam } from "./team";
import { renderUsageCost } from "./usage-cost";
import { renderSettings } from "./settings";
import type { ViewContext } from "../view-context";
const pages: Record<string,(ctx:ViewContext)=>string> = {"M1":renderM1,"Chat":renderChat,"Overview":renderOverview,"Projects":renderProjects,"Collaboration":renderCollaboration,"Sessions":renderSessions,"Decisions":renderDecisions,"Engineering DNA":renderEngineeringDNA,"Team":renderTeam,"Usage & Cost":renderUsageCost,"Settings":renderSettings};
export function renderPage(ctx:ViewContext):string { return (pages[ctx.nav.page] || pages.Settings)(ctx); }
