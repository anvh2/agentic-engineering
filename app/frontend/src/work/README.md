# Work UI migration

Work is the first React surface, using Radix Select and Lucide. Existing controller and storage remain authoritative during incremental migration. Browser Vite and Wails load the same entry point. No native select is rendered in Work. Other pages remain legacy until migrated and tested. Run npm install, npm run typecheck, npm run build, then wails dev on macOS. Verify create/edit/comment, project switching, existing issue keys and dropdown keyboard interaction. This change has not been verified on macOS.
