# Frontend boundaries

- main.ts: application entry point.
- controller.ts: DOM event handling and demo mutations.
- view-context.ts: shared view selectors and rendering helpers.
- pages/: individual page renderers.
- components/: reusable layout, dialog and primitives.
- services/: demo fixtures and local persistence only.
- types.ts: frontend demo domain types, not a finalized Go API contract.

Production integration should replace demo mutations with typed asynchronous Wails commands and authoritative Go state. Do not send entire mutable snapshots to Go or silently fall back to demo data in production. Keep generated bindings at the service boundary. Native runtime integration is not implemented here.
