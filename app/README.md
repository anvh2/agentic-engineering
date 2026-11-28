# Agentic Engineering V2 desktop

Go/Wails application with native CLI discovery, a temporary one-shot chat console, and core, SQLite, MCP and native adapter foundations. Desktop core bindings and authenticated end-to-end collaboration remain incomplete. See ../docs/v2/PROGRESS.md.

Requirements: Go 1.25+, Node 22+, macOS build tools, Wails v2.10.2.

```sh
cd frontend
npm install
npm run build
cd ..
go test ./...
wails dev
```

Run wails build for native packaging. Browser preview: npm run dev in frontend. Demo data is not execution evidence.
