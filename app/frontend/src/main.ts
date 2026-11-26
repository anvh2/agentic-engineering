import { demoStore } from "./services/demo-store";
import { createNavigation, createViewContext } from "./view-context";
import { mountController } from "./controller";
const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Missing application root");
mountController(root, createViewContext(demoStore.load(), createNavigation()));
