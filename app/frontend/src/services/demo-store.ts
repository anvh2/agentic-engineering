import type { AppState } from "../types";
import { starter } from "./fixtures";

// Local demo persistence only. Replace with asynchronous Go commands when
// the production contract is agreed; do not persist production snapshots here.
const key = "agentic-v2-app-demo";
export interface DemoStore { load(): AppState; save(state: AppState): void }
export const demoStore: DemoStore = {
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      if (value && ["projects","repos","objectives","sessions","messages","decisions"].every(k => Array.isArray(value[k])) && value.roles && value.knowledge && value.settings) {
        for (const project of value.projects) project.knowledge ??= {};
        return value;
      }
    } catch { /* fall back to fixtures */ }
    return structuredClone(starter);
  },
  save(state) { localStorage.setItem(key, JSON.stringify(state)); }
};
