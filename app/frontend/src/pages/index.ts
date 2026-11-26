import { renderChat } from "./chat";
import { renderOverview } from "./overview";
import { renderProjects } from "./projects";
import { renderObjectives } from "./objectives";
import { renderCollaboration } from "./collaboration";
import { renderSessions } from "./sessions";
import { renderDecisions } from "./decisions";
import { renderEngineeringDNA } from "./engineering-dna";
import { renderTeam } from "./team";
import { renderUsageCost } from "./usage-cost";
import { renderSettings } from "./settings";
import type { ViewContext } from "../view-context";
const pages: Record<string,(ctx:ViewContext)=>string> = {"Chat":renderChat,"Overview":renderOverview,"Projects":renderProjects,"Objectives":renderObjectives,"Collaboration":renderCollaboration,"Sessions":renderSessions,"Decisions":renderDecisions,"Engineering DNA":renderEngineeringDNA,"Team":renderTeam,"Usage & Cost":renderUsageCost,"Settings":renderSettings};
export function renderPage(ctx:ViewContext):string { return (pages[ctx.nav.page] || pages.Settings)(ctx); }
