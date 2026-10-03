# eshop — project state (lead-owned)

**Product:** Express/React/Postgres shop with an admin workspace; current customer work is the AI affiliate-video generator.

## Status
- Phase 1 (recovery) accepted and closed, 2026-10-03. Branch `recovery/2026-10-03`.
- Video generation currently lives in harness-engineering (`scripts/affiliate-video-generate.ts`, a temporary ffmpeg stub). eshop calls it as a child process via `VIDEO_PIPELINE_DIR` (`src/modules/workspace/lib/runAffiliateVideoPipeline.js`).

## Next milestone — NOT STARTED, awaits lead go-ahead
Create the initial `tools/affiliate-video` standalone package skeleton in eshop, which will later receive product generation code from harness.
- In scope: package.json, TypeScript/runtime config, module boundaries, test harness, preserving and testing the existing affiliate-video CLI contract (`--images --output [--sample-video] [--prompt] [--json]`, result read from the last JSON line on stdout).
- Out of scope: cloud provider calls, inference, moving the full generation implementation, QuickWorkspace behaviour changes, product architecture changes, ComfyUI, unrelated refactors.

## Decisions
- `.workdir/` (1.1 GB, harness) stays ignored and local; never commit, LFS, or delete.
- Seller photos in `docs/` and `sample-video.mp4` stay local and untracked; never publish.
- `config/default.json` and `config/production.json` carry intentional local DB changes; never commit or revert.

## Known baseline
- Full `npx jest --ci` is already red: 8 of 19 suites fail (NODE_ENV config strictness; one Cypress-style integration test). A failure in those suites is pre-existing, not a regression.
