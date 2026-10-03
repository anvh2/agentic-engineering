# Phase 0 results — 2026-09-27

**Review output:** [15-second baseline MP4](run-01/baseline-15s.mp4) · [five-shot contact sheet](run-01/contact-sheet.jpg).

The requested renderer-first order is now **0 → 2 → 3 → 4 → user approval → 1 → 5 → 6**. Only Phase 0 was executed. All production code, database integration, durable jobs, workspace UI and production recovery work remain deferred. Phase 2 has not started.

## Measured result

| Item | Result |
|---|---|
| Hardware | Apple M2; 17,179,869,184 bytes unified memory (16 GiB), independently read via sysctl |
| OS / FFmpeg | macOS 15.7.9 / FFmpeg 9.0.2 |
| Inputs | Three original photos of the same blouse: overview_3, detail_3, overview_1; hashes in metrics.json |
| Renderer | Five source-photo pan/zoom-style shots (centered gentle zoom), SVG typography, four 0.25s dissolves; no generated garment pixels |
| Export | H.264/yuv420p, 1080×1920, 30 fps, exactly 450 decoded frames / 15.000000 seconds |
| Output size | 3,829,217 bytes |
| Render wall time | **36.49 seconds**, includes overlay creation, five shot encodes and final composition; excludes process startup, preparation of benchmark code, later probing/QA |
| Shot encode times | 5.86, 5.55, 5.57, 5.58, 5.66 seconds |
| Composition | 8.02 seconds |
| Full decode validation | Passed; 0.32 seconds |
| Contact-sheet generation | 0.33 seconds |
| Highest measured subprocess RSS | 796,213,248 bytes ≈759 MiB during composition; not total machine or parent-process peak |
| Audio | Silent; no licensed music supplied |
| Cloud usage | None; $0 |

This is **one run on one product**, not a median/p95 or production SLA. The machine had existing swap usage and background applications; this was not a freshly rebooted clean-room benchmark. The AI workload was stopped and the idle model-unload request sent before the measured baseline run. Hardware and pre-baseline swap are recorded in [hardware.json](run-01/hardware.json). There was no concurrent benchmark inference during baseline rendering.

The first sandboxed attempt rendered a shot but failed resource-counter access in `/usr/bin/time`. It is excluded from the successful baseline timing. The successful run was repeated with macOS resource access enabled. Installed Sharp loaded successfully despite the earlier architecture review's concern about the repository's platform-specific install script.

## Local AI experiment

One real ComfyUI submission was attempted; this is not a mock. Exact graph, node API schemas, environment and server history are saved alongside the MP4.

- ComfyUI 0.37.0, PyTorch 2.15.0.dev20260924, MPS backend.
- Existing Realistic Vision SD1.5 + AnimateDiff `mm_sd_v15_v2` + IPAdapter PLUS.
- Original overview_3 source, byte-matched to the existing ComfyUI input. No AI-generated hero was substituted.
- 384×512, 16 frames at eight fps (two-second target), 16 steps, CFG 6, denoise 0.35, seed 555. Depth conditioning omitted to test a lighter variant; this is **not** an exact reproduction of the historical depth-conditioned graph.
- Eight-minute maximum was set, but the trial hit the conservative resource gate first.
- At submission: 2,031 MiB system swap used; at 20 seconds: 4,907 MiB. At final sample after interruption: 5,091 MiB. Reported free memory ranged from approximately 1.95 to 5.86 GiB during the sampled trial.
- The controller manually requested interruption after reviewing the rapid swap increase. Server history confirms `execution_interrupted` at the sampler, about **59.5 seconds** after execution start. Client completed its checks in **60.45 seconds**. Its own prompt was no longer queued/running.
- The reusable trial script was then updated to automatically stop on more than 2 GiB additional swap. That automatic guard was **not** the mechanism that stopped this first run; it was added afterward and not re-benchmarked.

**Outcome: resource-gate failure, no usable AI clip.** This was an intentional interruption, not a confirmed OOM, model crash, eight-minute timeout, or completed inference benchmark. System swap is shared with other processes, so it cannot all be attributed precisely to ComfyUI. The result is sufficient to keep this profile disabled by default under today's machine load, but not to conclude that all local I2V is impossible or to estimate its full completion time.

The idle server received a memory/model-release request after the prompt stopped. No server restart, model installation, other prompt cancellation, or configuration change occurred. Model filenames and submitted graph are recorded; model-file hashes and detailed MPS allocator peak measurements were not collected in this trial.

## Visual review and limits

The sampled output frames show the original blouse silhouette, collar and flower-shaped buttons, with consistent typography and intact source framing. This is a source-preserving edit: no diffusion is used to redraw details. The export is technically valid, and sampled shots were visually inspected; full-speed human playback is still required to judge pacing and motion smoothness.

Quality concerns visible in the actual output:

1. The source photographs already contain decorative star symbols, labels, hands, headphones and denim. These remain visible; they were not mistaken for garment structure or silently removed.
2. The wider third shot makes the blouse smaller within the designed frame. A more carefully selected/cropped hero would improve product prominence.
3. Only three source photos are available for this run, so the detail and hero views repeat. The camera effect is gentle zoom, not natural fabric motion or a novel viewpoint.
4. Lighting/shadows and sharpness come from the uploaded photos. Upscaling/export does not recover missing textile detail.
5. The silent edit is suitable for reviewing image handling, pacing and fidelity, but does not demonstrate the final music-led marketing experience.

No numerical marketing-quality score is invented. **User quality approval is pending.** Review the actual MP4, particularly whether this source-photo presentation is an acceptable fallback and what visual improvement would justify AI cost/risk.

## Untested and deferred

- Printed/logo and fine-lace product fixtures are missing. One blouse cannot establish broad fidelity.
- LTX node support exists, but LTX weights are absent; no download was started. Installed Wan VACE 1.3B weights are a different model/task and were not substituted into an unvalidated graph.
- No OpenAI/Gemini API credentials were configured (checked presence only); no cloud hero/removal comparison was run. Phase 3 remains separate.
- No new music, segmentation, product-reference service, reusable production renderer, database, durable job, workspace UI, persistence, worker restart test or production hardening was implemented.

**Decision:** deterministic rendering comfortably passes the timing/format gate for this fixture. Marketing-quality acceptance remains open. Current AnimateDiff profile does not pass the conservative resource gate. Next is Phase 2 as a separate step, informed by this output review; optional cloud assets and local animation follow in Phases 3 and 4. Integration Phases 1/5/6 remain behind explicit approval of the generated video and architecture.

## Evidence / reproduction

- [Renderer benchmark](render.mjs) and [instructions](README.md).
- [Render metrics and exact FFmpeg arguments](run-01/metrics.json).
- [Output probe](run-01/probe.json).
- [AI trial](comfy_trial.py), [submitted graph](run-01/comfy-graph.json), [AI samples](run-01/comfy-metrics.json), [server execution history](run-01/comfy-history.json), [resource-stop rationale](run-01/resource-stop.json).
- [Revised architecture/phase plan](../../ARCHITECTURE_REASSESSMENT.md).
