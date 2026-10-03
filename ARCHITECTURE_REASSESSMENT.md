# Independent architecture reassessment: product images to TikTok video

Review date: 2026-09-27. Scope: the working trees of `harness-engineering` and sibling `eshop`, including uncommitted prototype code and hidden experiment artifacts. This is an architecture review, not implementation approval. No application code was changed.

**Recommendation:** build a 15-second product marketing-video pipeline that treats raw catalog photos as product references, generates new marketing keyframes/scenes from those references, and uses motion/composition to turn accepted scenes into a vertical video. Preserve the garment's color, fabric texture, shape, print/logo and construction details as the primary quality constraint. Do not continue the source-video clothing-transfer architecture for this product.

The intended MVP is five convincing marketing shots built from generated product scenes, ideally including a person wearing or reviewing the garment. Raw product photos should be used as reference evidence, not merely animated as a slideshow. If reliable human modeling creates unacceptable artifacts or identity drift, fall back to high-quality product-commercial scenes: styled background, detail macro, editorial flat-lay, rack/mannequin/display, packaging or review-style shots. A deterministic source-photo renderer remains useful as a technical fallback, fidelity reference and final composition engine, but it is not the target creative output. ComfyUI is the primary path for the compute-heavy still and optional motion experiments; cloud generation is a bounded quality comparator, not a required production dependency.

Evidence labels used throughout:

- **FACT:** externally documented capability, arithmetic, or a check performed in this review.
- **REPOSITORY OBSERVATION:** directly inspected implementation or artifact. Historical timing claims are explicitly identified as historical and were not reproduced.
- **HYPOTHESIS:** plausible behavior or quality outcome, not established by this review.
- **BENCHMARK REQUIRED:** a decision needs measurements on the target machine/data.
- **RECOMMENDATION:** proposed design or operating policy, not existing behavior.

## A. Current architecture

### Three distinct pipelines, not one integrated implementation

**REPOSITORY OBSERVATION — live affiliate workspace:**

```text
eshop QuickWorkspace React page
  -> multipart POST /workspace/jobs
  -> files under media/affiliate-video/uploads/<upload-run-id>
  -> one process-global JavaScript job object
  -> fire-and-forget child Node process in harness-engineering
  -> scripts/affiliate-video-generate.ts
  -> FFmpeg fixed-image slideshow
  -> media/affiliate-video/outputs/<job-id>/result.mp4
  -> update global job object
  -> GET /workspace/job-latest polling
  -> browser video player
```

The exact creation route is defined in `eshop/src/modules/workspace/api/createAffiliateVideoJob/route.json`; the route path should be treated as authoritative when implementing clients. The current frontend receives its URLs through the route builder.

| Stage and evidence | Input/output and responsibility | Cost/blocking behavior | Persistence, retry, errors |
|---|---|---|---|
| `eshop/.../quickWorkspace/QuickWorkspace.jsx` | 2–4 images, optional sample video, product text and prompt → multipart request | Browser upload; loads current job before choosing form/result | Browser state; polls server; no shot progress. Fetch error returns `null`, which initial load treats as no job |
| `eshop/.../createAffiliateVideoJob/[bodyParser]multerFile[auth].js` | Upload → local files; extension filter, max four images/one video | Disk write before handler's active-job guard; 200 MB per-file cap | Files persist; no decoded-image/pixel validation or rejection cleanup here |
| `eshop/.../createAffiliateVideoJob/[multerFile]handle[auth].js:29` | Files → job UUID, metadata, queued response | HTTP does not wait for generation | Checks one process's active job; no database transaction, idempotency key, or persisted product |
| `eshop/.../lib/affiliateVideoJobStore.js:12` | Current job → latest status | Negligible | One global object shared by admins; replaced by next job; restart loses it |
| `eshop/.../lib/runAffiliateVideoPipeline.js:49` | Local paths/prompt → CLI result → public URL | Child process; parent accumulates stdout/stderr; default 30-minute timer | No retry/checkpoint; errors mark global object failed; kills child, not ComfyUI or guaranteed descendants |
| `scripts/affiliate-video-generate.ts:62` | Image paths → slideshow MP4 | Synchronous FFmpeg inside child process; no AI | Two seconds/image, 768×1024, 24 fps; no timeout inside this script; prompt/sample video only recorded in metadata |
| `eshop/.../getLatestAffiliateVideoJob/getLatestAffiliateVideoJob.js` | No job ID → shared current object | Short HTTP request | Private route, all authorized admins see same job; no history or per-shot access |

Product name, description and category are stored in the ephemeral object but are not forwarded to the renderer. The caller discards returned renderer metadata when completing a job. No product-understanding, segmentation, hero generation, shot planning, music, captioning, QA, or upscaling stage is connected to this flow.

**FACT — checks in this review:** `ffprobe` on three existing affiliate outputs found 768×1024 at 24 fps: two were 4.083333 seconds/98 frames, one was 6.083333 seconds/146 frames. Thus the nominal 4–8-second slideshow calculation is not an exact frame-duration contract either.

**REPOSITORY OBSERVATION — older transformation route:** `eshop/.../api/generateVideo/[multerFile]handle[auth].js` still exists and remains in the editor role allowlist. It holds the HTTP request open while calling `scripts/video-transform.ts` with a source video and a clothing image passed as `--character`.

```text
source video + character reference (+ optional outfit in harness CLI)
 -> validate files/tools -> ffprobe -> extract every frame at capped FPS/size
 -> ComfyUI /prompt -> poll /history/<prompt-id> -> download /view output
 -> copy/reassemble video -> mux source audio -> probe output -> delete scratch
```

This path uses `src/mastra/video/{pipeline,ffmpeg,validate,config,types}.ts`, a provider factory, and `providers/comfyui-provider.ts`. The registered Mastra workflow wraps the same operations in four straight-line steps. The affiliate workspace does **not** call this workflow. Mastra's LibSQL/DuckDB configuration in `src/mastra/index.ts` therefore does not persist affiliate jobs.

The bundled graph uses Realistic Vision SD1.5, AnimateDiff `mm_sd_v15_v2`, pose ControlNet, DWPose, IPAdapter, VAE encode/decode, and VideoHelperSuite. It performs 20 diffusion steps with denoise 0.55 over source-frame latents; sliding context is 16 frames with overlap four. Preprocessing already caps FPS and longest dimension; it does **not** simply infer at original upload resolution. However, `prepareVideo` passes the original video's width/height to providers after resizing frames.

**REPOSITORY OBSERVATION — isolated experiments:**

- `.workdir/quick-video/scratchpad/DESIGN_SUMMARY.md`: v2/v3 masked source-video transformations; v4 six generated keyframes plus optical-flow appearance propagation. This still inherits source-garment geometry and depends on a source video, masks, and scene boundaries.
- `comfy-affiliate-v1/PRODUCT_REFERENCE.md`: manually written, detailed product description; useful evidence for a reference-pack concept, not an automated product service.
- `comfy-affiliate-v1/wf_c2b.json`: single still from source photo, 512×768, depth ControlNet 0.55, IPAdapter 0.65, 30 steps, denoise 0.35.
- `comfy-affiliate-v1/wf_video1.json`: approved hero repeated 16 times, depth/IPAdapter/AnimateDiff, 24 steps, denoise 0.35, eight fps. These are UI-format graphs, not drop-in substitutes for the HTTP adapter's API-format template.
- `run_video1.json` records a 600-second WebSocket timeout. A subsequent watch artifact contains an invalid-option error; another is empty. These do not establish completion time. An output file does exist: this review probed it as **512×768, 16 frames, eight fps, two seconds**. Existence proves an artifact, not fidelity acceptance, reproducibility, or a latency SLA.

### Storage, documents and tests

`eshop` already has PostgreSQL catalog `product`, `product_description`, and `product_image` tables (`src/modules/catalog/migration/Version-1.0.0.js`). The workspace migration only creates `workspace_shortlink`. No affiliate job/shot/asset migration or durable worker was found in the current workspace implementation.

Historical documents inspected: both READMEs/package manifests; `VIDEO_TRANSFORMATION.md`; `eshop/requirement/AI_AFFILIATE_GENERATOR_PRD.md`; `eshop/deployment/VIDEO_TRYON_DEPLOYMENT.md`; Trellis video task PRDs; scratchpad design, product reference, graphs and run records. Earlier task documents propose persisted jobs and describe the transformation pipeline as reusable unchanged; current code and the new product requirements do not support those conclusions. The harness documentation's unverified-ComfyUI warning also predates later deployment notes reporting successful runs. Neither document alone describes the present integrated product.

**FACT — verification:** ran `node --test src/mastra/video/*.test.ts src/mastra/video/providers/*.test.ts src/mastra/video/ffmpeg.itest.ts`: **49 passed, zero failed, zero skipped**, including three real FFmpeg integration checks. These test plumbing, not garment fidelity or M2 inference. No workspace-specific tests were found. No live inference, paid API generation, full application build, database migration, or browser acceptance test was performed.

Both working trees already contain extensive uncommitted work. This review does not establish a released/deployed version. Existing environment files were checked only for relevant non-secret video settings; no active video overrides were found in those files. Exported runtime environment and the running external ComfyUI configuration remain unverified.

## B. Current problems

### Confirmed in implementation

1. **The connected product is a stub.** Wrong duration/aspect ratio for the request; prompt and style-reference video have no rendering effect. This is more than a missing ComfyUI call.
2. **Job recovery is absent.** Restart loses state, new jobs replace history, no per-shot records exist. An active-job check in a single process is not a machine-wide GPU lock. The legacy route and independent CLI runs bypass it.
3. **Outfit reference is disconnected in the bundled graph.** Node 3 loads `OUTFIT_IMAGE`, but no downstream node consumes it. The documentation's second outfit-conditioning pass is not present. This finding concerns the bundled transformation graph, not the separate affiliate experiments.
4. **Timeout is not cancellation.** ComfyUI requests have no per-request abort deadline; the polling-loop deadline cannot stop a hanging `fetch`. A client timeout leaves server inference running. The eshop wrapper kills only its child PID. Blind retry can overlap the original work.
5. **Recovery inputs are not durable.** Seeds are generated inside `transform()` and not returned; prompt IDs are not persisted as jobs; no graph/model hash, attempt history, or stage timings reach the affiliate job. Successful transformation deletes intermediate assets.
6. **Output validation is too weak.** Adapter chooses the first recognized `gifs` or image output rather than a declared terminal node. Transformation completion tolerates failed output probing; affiliate completion trusts `{ok:true}` without independently validating the file or exit status. Neither establishes 15 seconds, 9:16, fidelity, or temporal quality.
7. **Resource controls are incomplete.** Large files are filtered by extension rather than decoded content; no total pixel budget. Rejected/conflicting uploads can remain on disk. The stub lacks an internal FFmpeg deadline. Both subprocess wrappers accumulate logs in memory; even `process-runner.ts` truncates only after capture.
8. **Size metadata is inconsistent.** Resized frames are accompanied by original dimensions. The bundled graph does not currently consume WIDTH/HEIGHT, so this is a provider-contract defect, not evidence it currently infers at original resolution.
9. **UI recovery is partial.** Current-job-on-load and a 409 conflict guard already exist and should be retained. Initial polling failure nevertheless opens an empty form; a null/error response must not mean “no active job.” “Try Again” starts a new upload flow, not asset/shot reuse.
10. **Deployment portability needs work.** Default sibling repo path is machine-specific. eshop allows Node 18 while the child entry point uses newer Node flags/TypeScript execution; choose one supported runtime for both. eshop's postinstall explicitly installs Linux x64 Sharp, which is unsuitable as a portable native Apple Silicon image-preparation setup.

### Historical observations, not independently reproduced measurements

`eshop/deployment/VIDEO_TRYON_DEPLOYMENT.md:309` reports two approximately **20.5-minute** M2/16 GB runs for **five seconds/40 frames**, at eight fps and longest side 512. It reports longer clips (87+ frames) stalling with high swap use at multiple resolutions. The notes' advice to raise timeouts to an hour conflicts with the new 20–30-minute constraint.

The scratchpad design reports approximately **1,512 seconds for six keyframe diffusions** plus about **63 seconds** of deterministic operations for a 14.17-second optical-flow prototype. This is historical experiment evidence, not a repeatable measurement of the proposed system. CPU activity alone cannot reliably diagnose GPU progress or distinguish all memory stalls; do not turn the deployment note's CPU heuristic into the production watchdog.

### Suspected / benchmark-dependent

- **HYPOTHESIS:** depth plus IPAdapter plus temporal diffusion spends scarce memory regenerating product pixels that should often remain unchanged. The conditioning stack can stabilize structure but cannot guarantee exact logo/button/print preservation.
- **HYPOTHESIS:** repeated-still AnimateDiff may provide too little useful motion to justify its cost, or mutate details. A negative prompt is not an identity constraint.
- **BENCHMARK REQUIRED:** actual peak unified memory, swap growth, cold/warm latency and usable-shot acceptance rate. GPU VRAM figures from NVIDIA do not translate into M2 unified-memory budgets.
- **BENCHMARK REQUIRED:** whether a source-preserving commercial edit is attractive enough to satisfy this user's quality bar. Deterministic motion does not produce new viewpoints or physical fabric motion.
- Historical optical-flow claims of “no hallucinated anything” are too broad: deterministic propagation cannot invent semantic content, but it can stretch logos, smear textures, expose occlusion holes, and propagate an already-wrong keyframe. It does not solve garment identity.

## C. Assumption audit

| Actual existing assumption | Decision | Reason |
|---|---|---|
| 2–4 target photos are primary input | KEEP | Fits product; preserve originals and detail views |
| Sample video is optional | KEEP / simplify | Style reference only; defer automatic video analysis in MVP |
| Slideshow stub can become real generation by wiring an existing graph | CHANGE | Need timeline, assets, fidelity policy, recovery and deadline controls |
| Source-video appearance transfer is the right provider contract | REMOVE from affiliate path | Wrong input and responsibility for static-product marketing |
| FFmpeg handles mechanical media operations | KEEP / expand | Make it the main renderer and compositor |
| Preprocessing should cap resolution and FPS | KEEP / correct | Already present; make dimensions model-specific and accurately recorded |
| Every source frame needs diffusion | REMOVE | Poor compute use for this product |
| Pose/person transformation belongs in default graph | REMOVE | No person/pose requirement in the new brief |
| IPAdapter/depth will preserve identity | INVESTIGATE | Useful conditioning, no hard fidelity guarantee |
| AnimateDiff is the default video solution | INVESTIGATE | Existing timing evidence is unfavorable; benchmark against a smaller I2V candidate |
| HTTP submission/history polling abstraction | KEEP / adapt | Add durable IDs, bounded requests, reconciliation and declared outputs |
| One shared admin job is sufficient | CHANGE persistence, KEEP shared scope initially | A global workspace is an existing deliberate behavior; durable history does not require a multi-tenant redesign |
| In-memory state is sufficient | REMOVE | Explicit restart and individual-shot recovery requirement |
| Current-job hydration/polling in UI | KEEP / adapt | Already solves a useful part of the experience |
| Manual product-reference notes are useful | KEEP concept | Convert to versioned evidence-backed metadata; do not treat inferred material as fact |
| Optical flow from an unrelated garment video preserves product identity | REMOVE from default | Carries wrong silhouette and occlusion geometry |
| Provider abstraction can remain unchanged | CHANGE | Introduce shot render input/output; retain transport utilities |
| Tests passing proves model quality | REMOVE | Current tests validate mechanics only |

## D. Architecture alternatives

Numbers below are planning expectations or recorded history, not new M2 benchmarks.

| Approach | Quality / fidelity / temporal consistency | M2 memory and latency | Cloud cost | Complexity, recovery, maintainability, MVP effort |
|---|---|---|---|---|
| **A: actual current affiliate path** | Static slideshow; source identity retained subject to scaling; no temporal AI artifacts; weak marketing treatment | Low compared with diffusion; current latency unmeasured, short FFmpeg job | $0 | Simple/low effort, but ephemeral whole-job recovery and wrong deliverable |
| **A2: existing transformation/experiments** | More motion; soft identity transfer; mutation/warp risks | Historical 5s ≈20.5min; long-clip memory trouble. Six keyframes ≈25min in another recipe | $0 | Many custom nodes/manual assumptions; high maintenance; no integrated shot recovery |
| **B: continuous 15s local generative video; fully local heroes** | Potentially cinematic; largest identity/temporal risk | No supported 20–30min case. Heavy shared memory. Linear extrapolation from historical 5s is ≈61.5min before prep, and is optimistic because scaling is nonlinear | $0 | High implementation/tuning effort; expensive retries; reject as default |
| **C: cloud heroes + 7–11s local animation + composition** | Better starting images may help; multiple re-generated heroes can disagree; animation still mutates product | Unknown. Historical proportional estimate for 7–11s is ≈29–45min of inference alone, not a benchmark of a new I2V model | Image calls plus retries; no cloud video | Medium/high effort; sensible only with durable shots and measured faster renderer |
| **D: mostly deterministic, minimal optional animation** | Best identity retention, but looks like enhanced catalog media rather than newly generated marketing scenes | Modest CPU/buffer load; hypothesized minutes. Local AI remains optional and separately bounded | $0 without APIs | Low/medium effort; useful as control/fallback/compositor, **not sufficient for the intended product** |
| **E: ComfyUI-generated marketing keyframes + source-fidelity checks + local composition** | Intended direction: new scenes using catalog photos as references; can attempt wearer/reviewer scenes, with fallback to styled commercial product scenes when human modeling drifts | Still and optional video inference are the costly M2 stages; peak memory, swap, latency and accepted-output rate **BENCHMARK REQUIRED** | $0 provider cost; account for M2 runtime/energy and rejected attempts | Medium effort; progressive enhancement with explicit rejection/fallback; **recommended product basis** |
| **E2: one cloud I2V shot + local edit** | Potentially stronger physical motion; identity still requires QA | Low local memory; provider latency/queue unknown | Greater/variable; require provider quote and budget before enablement | One additional adapter; plausible future option if local experiment fails and motion is essential |

Cloud hero generation plus local animation is a useful option, not an architectural requirement. Producing an attractive keyframe first decouples composition from animation, but it does not necessarily reduce the video model's compute at the same resolution/frame count. It primarily reduces creative uncertainty and allows early rejection.

## E. Recommended architecture

```text
2–4 originals + optional description/prompt
                 |
                 v
        validate/decode/orient/hash
                 |
                 v
   versioned product reference assets
   originals + crops + optional masks + attributes/evidence
                 |
                 v
       15-second marketing shot plan
       wearer/reviewer if reliable, otherwise styled product scenes
                 |
                 v
   generate only the marketing keyframes/assets the shots need
   ComfyUI still generation first; bounded remote comparator only if useful
                 |
                 v
        per-asset fidelity and marketing decision
                 |
       +---------+----------------------+
       |                                |
       v                                v
 FFmpeg/composition             optional local I2V shot
 accepted generated scenes       serialized, deadline-limited
 plus source fallback/control
       |                                |
       |                       accept OR replace with
       |                       deterministic shot
       +----------------+---------------+
                        v
             timeline composition
        captions / CTA / music / transitions
                        |
                        v
             technical + visual QA
                        |
                        v
      atomic publish 1080×1920, 15s MP4

PostgreSQL: jobs, shots, attempts, assets, timeline versions
One local worker: leases, cancellation, deadlines, recovery
eshop UI: current durable job + actual stage/shot status
```

Plan before expensive keyframes so the system does not create unused images. A first template uses **3s hero + 3s detail + 3s alternate view + 3s construction detail + 3s hero/CTA**. Use detail crops when only two source photos exist; do not invent a back view. Specify time in integer output frames: 450 frames at 30 fps. Crossfades overlap clips, so their handles must be additional source duration or be accounted for in the timeline; five three-second inputs with overlapping transitions otherwise produce less than 15 seconds.

Use modest zoom and pan within accepted generated scenes, and preserve raw catalog images as reference/control material. The final video should look like newly created marketing content, not a direct slideshow of uploads. Keep logo/print and fine construction-detail evidence available as cut-ins or comparison checks when generated scenes are uncertain. Optional I2V can occupy two seconds within a three-second shot, with approved still motion for the remaining second; do not stretch a two-second generated clip into implausibly slow motion.

Preserving source pixels does not mean the final encoded video is byte-identical: resizing, compositing, color conversion and compression change values. It means the garment is not semantically regenerated. Protect opaque garment interiors during background edits; alpha edges need visual QA. If segmentation fails, use the complete source photo with a designed frame/background instead of forcing a bad cutout.

Do not infer precise fiber composition, actual garment size, unseen details, price or marketing claims from pixels. Store uncertain attributes as unknown/inferred with source-image references. Resolve conflicting color/view evidence conservatively and let authoritative user descriptions override uncertain model labels.

## F. Local versus cloud responsibility

| Component | Location and default | Rationale/fallback |
|---|---|---|
| Auth, uploads, job/asset records | eshop + existing PostgreSQL | Reuse infrastructure; worker independent of HTTP request lifetime |
| Decode, EXIF orientation, sRGB conversion, crop, hash | Local FFmpeg/Sharp after native install validation | Cheap, deterministic; preserve untouched originals |
| Product understanding | Optional cloud multimodal call; template works without it | Avoid another resident local LLM competing with video memory; schema-validate output |
| Segmentation | Optional local small CPU model | Skip entirely for usable source photos; cloud removal only if it materially improves masks |
| Marketing keyframe/scene generation | Essential Phase 3 local ComfyUI still profiles | Make the expensive local still workflow earn its M2 budget; use existing checkpoint, ControlNet and IPAdapter evidence as starting profiles. OpenAI may guide shot planning, prompts and QA, but the worker renders locally. Every accepted scene must pass garment-fidelity checks. Remote generation is comparison-only. |
| Shot planning | Local template/rules; optional constrained prompt interpretation | Predictable duration, cost and recovery; no autonomous agent loop |
| Generative animation | Local ComfyUI only after benchmark gate | One owner, one shot at a time; deterministic replacement on rejection/timeout |
| Crop/zoom/text/audio/timeline/export | Local FFmpeg | Composition/export layer for accepted generated scenes and fallback source-reference shots |
| Upscale | Local deterministic resampling by default | Generate text after video scaling; AI upscale is optional still-only experiment |
| Quality checks | Local technical checks + visual review; optional cloud triage | Vision scores are advisory, not a guarantee of identity |

One worker process can be added alongside the existing app and PostgreSQL. No Redis, distributed queue broker, extra microservice fleet, or LLM supervisor is needed. Keep rendering modules in harness-engineering and orchestration/business state in eshop. A versioned manifest + structured event stream is sufficient across the existing subprocess boundary. A Mastra wrapper may expose the same stages, but it must not become a second authoritative job database; register any new Mastra components in `src/mastra/index.ts`.

## G. Model and resolution strategy

**There is no verified winning local I2V model for this M2 in the reviewed evidence.** The first launchable architecture must work without one. “Supports MPS” only establishes a backend path; it does not establish speed, peak memory, custom-node compatibility or usable quality.

Memory figures marked *weight floor* are arithmetic, not runtime memory predictions. Any unknown working-set peak must remain **BENCHMARK REQUIRED**, rather than substituting model-file size.

| Stage/candidate | Memory and Apple compatibility | Speed/quality expectation and limitations | Decision |
|---|---|---|---|
| Product understanding: Gemini Flash vision family or equivalent compact hosted vision model | API; no local model working set. Exact model/version pinned after evaluation | Network/API latency **BENCHMARK REQUIRED**; suitable for descriptions and crop hints, can misread small details/materials | Optional; compare against user text plus rules. [Official image-understanding docs](https://ai.google.dev/gemini-api/docs/image-understanding) |
| Mask: rembg `u2netp` / `u2net`, CPU ONNX | CPU route avoids CUDA dependency. U2-Net project lists approximately 4.7 MB/176.3 MB weight files; decoded tensors/runtime add memory, peak unknown | **BENCHMARK REQUIRED**; lace, straps, white-on-white and hands are difficult. Clothing-on-person parser is not general flat-lay segmentation | Small local baseline; original-photo fallback. [rembg](https://github.com/danielgatis/rembg), [U2-Net](https://github.com/xuebinqin/U-2-Net) |
| Mask: remove.bg API | Remote compute; local decoded assets only | **BENCHMARK REQUIRED** on garments/edges; per-call cost and output size depend on selected plan | Fallback candidate, not mandatory dependency. [API docs](https://www.remove.bg/api) |
| Hero/background: Gemini `gemini-3.1-flash-image` | Remote; no local GPU requirement | Supports reference-image editing; exact garment accuracy and API latency **BENCHMARK REQUIRED** | Compare 1–2 background/composite candidates, not five independent garment redesigns. [Image docs](https://ai.google.dev/gemini-api/docs/image-generation) |
| Hero/background: OpenAI GPT Image family | Remote; no local GPU requirement | Current guide lists GPT Image 2.5 models; high-fidelity reference handling still is not a product-identity guarantee. Latency **BENCHMARK REQUIRED** | Benchmark a currently accessible model against Gemini; pin ID/quality/size, do not select by brand. [Official image guide](https://developers.openai.com/api/docs/guides/image-generation) |
| Local still: existing Realistic Vision SD1.5 + optional depth/IPAdapter | Multi-component model and activation working set; exact peak **BENCHMARK REQUIRED**. Existing MPS experiment artifacts | Historical still notes show minutes/frame; modifying all garment pixels risks detail loss | Research baseline only; no default local hero regeneration |
| Local video: existing SD1.5 AnimateDiff | Multiple resident modules plus temporal activations; exact peak **BENCHMARK REQUIRED**; long-clip swap reported | Two-second artifact exists, 600s client timeout recorded; no proven acceptable short-shot SLA | Baseline comparator, not assumed winner |
| Local I2V: LTX-Video 2B distilled `0.9.8` | Approximately 4 GB for 2B FP16 parameters alone, excluding text encoder/VAE/activations. Official repo documents MPS support; total peak unknown | Distillation makes it a plausible small-model test, not a speed promise. Details/motion may degrade at small sizes; M2 timing **BENCHMARK REQUIRED** | First alternative to test if already installed or setup is quick. [Official LTX-Video](https://github.com/Lightricks/LTX-Video) |
| SVD-XT class I2V | Multi-GB model stack; total MPS memory/compatibility of chosen implementation unknown | Short I2V candidate; product fidelity and portrait behavior unverified | Secondary research only; not in first-hour critical path. [Official model card](https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt) |
| Wan2.1 I2V 14B | FP16 transformer weight floor ≈28 GB alone; quantization/offloading changes runtime but requires proof | Official 8.19 GB/4min figure is **T2V-1.3B on RTX 4090**, not I2V on M2 | Exclude default. [Official Wan2.1](https://github.com/Wan-Video/Wan2.1) |
| Current LTX desktop stack (2.5/2.3) | Official desktop gates local Mac generation on at least **15 GB free RAM**, not total RAM; distinct from older 2B model | A 16 GB machine running the OS/app has insufficient practical headroom; no M2 latency evidence here | Exclude default; do not confuse generations or free/total memory. [Official desktop requirements](https://github.com/Lightricks/LTX-Desktop) |
| Upscale: FFmpeg Lanczos; optional tiled Real-ESRGAN still | FFmpeg has frame buffers, no AI weights. Real-ESRGAN runtime/tile/backend memory **BENCHMARK REQUIRED**; validate actual Mac backend | Resampling does not restore lost detail; AI restoration can invent texture or alter logos | Keep source resolution for deterministic shots, upscale only when needed. [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) |

ComfyUI itself supports Apple Silicon installation, but each selected model, precision and custom-node combination needs a pinned working environment. Do not assume CUDA-oriented low-memory or FP8 recipes work unchanged on MPS. [ComfyUI installation](https://github.com/Comfy-Org/ComfyUI).

**Working resolutions:**

- Originals remain immutable. Produce orientation-corrected previews and separate renderer derivatives; do not globally downscale all product evidence.
- Deterministic shots can sample high-resolution originals directly into a 1080×1920 canvas, preserving detail for zooms. Never stretch a garment to fill 9:16; fit it with designed surrounding space or crop around a verified safe region.
- For existing AnimateDiff experiments, begin at a small tested working size such as 288×512 or the existing 512×768, with a short frame count. This is an experiment setting, not a quality recommendation. SD-family latent dimensions should respect the actual VAE/node constraints, not merely even codec dimensions.
- For LTX 2B test 288×512 or 384×640, dimensions divisible by 32, and 33/49 frames (8n+1). Choose one fixed profile first. A 49-frame/24-fps clip is roughly two seconds; retain actual output timing. Official LTX guidance documents these divisibility rules. [LTX resolution guidance](https://github.com/Lightricks/LTX-Video).
- 576×1024 has four times the pixels of 288×512; 720×1280 has 6.25 times. These are pixel ratios, **not linear latency guarantees**. Neither higher resolution is an M2 default without measurement.
- Render captions/CTA at final resolution. Keep generative upscaling and optical-flow frame interpolation out of MVP by default; both can introduce artifacts. Encoding at 30 fps does not turn eight unique generated frames/second into 30 unique motion samples.

**Cost comparison:** local deterministic processing has no per-call provider fee. The primary cost focus is ComfyUI's M2 time, unified-memory pressure, swap growth, electricity and rejected-shot rate; report all of these per attempted and accepted keyframe. Remote image prices remain a comparison baseline only: GPT Image 1.5 lists $0.05 medium or $0.20 high per 1024×1536 output, excluding input usage; two outputs are $0.10/$0.40 plus inputs. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-image-1.5). Gemini 3.1 Flash Image lists $0.067 for a 1K output, so two are about $0.134 plus inputs/other usage. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing).

Use a proposed configurable **$1/job asset-generation ceiling**, not an assertion that every provider/job costs less than $1. Reserve estimated maximum cost before each call, cap attempts and reconcile usage. If no reliable estimate is available, do not issue an unbounded optional call. Compare **cost per accepted asset**, not price per generated image. Include rejected outputs, analysis and retries; free trials and batch pricing are not a production latency plan.

## H. Performance budget

**RECOMMENDATION — deadline allocations, not measured runtimes:**

| Stage | Maximum planned allocation | Enforcement |
|---|---:|---|
| Local validation/preparation | 1:00 | Bounded file/pixel sizes; unsupported inputs rejected |
| Optional understanding | 0:30 | Skip/fall back to text/template on failure |
| Optional masks/heroes/API work | 3:00 | All optional attempts share this cap; retain originals |
| Planning + asset fidelity triage | 0:30 | Deterministic plan; human waiting excluded and shown separately |
| Deterministic clips/base export | 2:00 | Build usable baseline before optional video inference |
| One local AI shot | 8:00 | Includes model load, submission, inference and download; one initial attempt |
| Stop/reconcile provider work | 1:00 | Verify ownership and termination before fallback composition |
| Compose, final scale/encode/audio | 2:00 | Reserve independently of inference budget |
| Technical QA + publication | 1:00 | Decode/probe checks, atomic publish |
| Reserve for bounded recovery | 4:00 | Recompose/recover; not permission for repeated AI runs |
| **Total** | **23:00** | **7:00 headroom to 30-minute ceiling** |

Every allocation is **BENCHMARK REQUIRED**. A budget is not proof that a renderer fits it. Deterministic-only elapsed target is approximately 3–10 minutes depending on optional assets and CPU load; this is a hypothesis to test, not a reported benchmark. The service should finish sooner when possible, rather than consuming 20 minutes unnecessarily.

Use an absolute job deadline. Do not start optional inference unless its maximum duration plus cleanup/export reserve fits. Stop optional work early enough to publish the already-rendered baseline. One OOM does not justify another eight-minute attempt when the reserve is exhausted. A machine-wide crash or unresponsive OS cannot be turned into a hard completion guarantee; report failure truthfully and preserve recoverable work.

Define SLA from **admitted processing start** and show upload/queue time separately. If the product requires 30 minutes from submission, enforce admission/backpressure: one M2 cannot accept an arbitrary backlog and promise every job finishes in 30 minutes. Model installation/downloads belong to deployment, not a hidden per-job allowance. Benchmark with realistic browser/app load, close competing local models, and run only one diffusion workload at a time.

## I. Data model

Use the existing PostgreSQL database. Do not overload commerce Product with transient rendering details, and do not require creating a sellable catalog item just to make a video.

| Entity | Proposed minimum fields and behavior |
|---|---|
| Product reference | `id`, nullable catalog `product_id`, name/description snapshot, version, attribute JSON with confidence/source image IDs, original asset IDs. A small reference record gives reuse across jobs; catalog schema can remain unchanged |
| VideoJob | UUID, workspace scope/creator, reference version, input/prompt snapshot, status/stage, deadline, plan revision, output asset ID, cost ceiling/reserved/actual cost, idempotency key, heartbeat/lease owner/token/expiry, timestamps and terminal reason |
| Shot | UUID, job ID, order, revision, renderer/profile, source asset IDs, duration in frames, crop/motion/transition parameters, prompt/seed, model/workflow hash, status, selected attempt/output, fallback renderer, retry count |
| Asset | UUID, immutable storage key/hash, role, parent IDs, MIME, dimensions, frame count/FPS/duration where relevant, recipe hash, status/acceptance, provenance/provider/model/version and timestamps |
| ShotAttempt / stage event | Attempt ID, shot/revision, external request ID, lease/fencing token, start/end/queue/inference/download times, config, memory samples/OOM, usage/cost, output IDs and structured error |

The reference pack is a logical collection of records and immutable files, not a mandatory fixed folder tree. Generate masks/detail crops only when used. Keep originals, accepted assets and shot outputs; garbage-collect temporary files after a retention period. Never delete dependencies of a published output. Content hash + recipe/model version gives cache identity, not filename alone.

Persist one authoritative owner for shared workspace jobs. Preserve the existing all-admin shared workspace initially; record creator for auditing and authorize all new endpoints consistently. If workspace/tenant isolation is later added, scope queries/assets then. Enforce a database-level active-job constraint for the chosen shared scope and a worker/GPU lease; a UI disable is not concurrency control.

## J. Job states, retries, recovery and observability

Keep status small and stage descriptive:

```text
QUEUED -> RUNNING -> COMPLETED
             |----> FAILED
             |----> CANCELLED
             +----> NEEDS_REVIEW -> QUEUED (new revision/selection)

RUNNING.stage:
  PREPARING -> PLANNING -> PREPARING_ASSETS -> RENDERING
            -> COMPOSING -> QUALITY_CHECK -> PUBLISHING

Shot:
  PENDING -> RUNNING -> READY
                |----> RETRY_WAIT -> RUNNING
                |----> REJECTED -> fallback/new attempt
                +----> FAILED or CANCELLED
```

Skipped stages remain skipped, not fake “generating images” progress. Show `Rendering shot 2/5`, backend-reported progress where available, elapsed time and a bounded estimate. Human approval is optional: the automated mode uses source-safe fallback; a requested manual review enters NEEDS_REVIEW and pauses machine-SLA accounting visibly. Do not conceal unbounded human review inside a 30-minute promise.

**Execution protocol:** atomically claim with a lease/fencing token; persist stage/attempt before expensive work; pass IDs in a versioned manifest; emit structured progress events; validate output and atomically rename temp files before recording READY. Updates must match job ID, attempt ID, revision and fencing token, so an old child cannot overwrite newer work. Add unique idempotency keys and transactional job/asset creation. No open database transaction around inference.

Persist a ComfyUI prompt ID as soon as submission returns and reconcile it with history/queue after restart. A crash after submission but before recording the response is an ambiguous-submission window: correlate a client attempt ID with provider metadata where supported, search/reconcile, and quarantine ambiguity rather than blindly resubmit. Exactly-once remote execution is not guaranteed. Download a finished output instead of regenerating it.

| Failure | Response |
|---|---|
| Bad hero | Reject only that asset; one bounded new candidate or use original composite; retain accepted siblings |
| Bad animation | Reject only that shot attempt; deterministic replacement, or explicit new revision later |
| API 429/temporary 5xx/network error | Bounded backoff with jitter, honor retry hints and global deadline; at most two total attempts for optional asset operations; reconcile ambiguous billable requests |
| Invalid request/model missing | No blind retries; actionable configuration error or fallback |
| ComfyUI crash/restart | Reconcile known prompt; retry only unfinished shot if time remains; otherwise fallback |
| OOM/memory pressure | Release model/workload; smaller prevalidated profile once only if budget permits; otherwise deterministic. Do not disable memory safeguards to “make it fit” |
| Timeout/cancel | Remove own queued prompt or interrupt owned running inference, verify stop, fence late results; never interrupt unrelated manual work |
| Worker restart | Reclaim expired lease; inspect existing assets/external request status; resume first unfinished stage |
| FFmpeg/composition failure | Retry composition from READY shots; preserve last published output until replacement passes QA |
| Partial file/invalid output | Keep temporary artifact for diagnosis; do not publish success |

A dedicated ComfyUI instance or exclusive controlled access is needed if interrupt is instance-wide. If safe cancellation cannot be established, disable optional local inference rather than starting more work beside an orphan job.

Retry one shot by creating a new attempt/revision, retaining the previous accepted output. Recompose only after replacement passes QA. Editing captions changes composition, not inference; changing one hero invalidates only shots depending on it. Completed videos remain downloadable while revisions render.

Persist stage/model/model hash/workflow hash/seed/width/height/frame count/FPS/steps/precision, request ID, retries, chosen fallback, outputs and rejection reason. Split queue, model-load, inference, download, encode and review time. Record process RSS, system memory pressure/swap deltas, and MPS allocated/reserved memory where available; note RSS alone misses some unified-memory accounting. Store unknown memory/cost as unknown, not zero. Capture API usage and estimated versus billed cost. An attempt timeline must make a 42-minute job explainable and allow comparisons by accepted-output rate.

Technical QA: expected codec/container, 1080×1920, 450 frames at 30 fps within chosen timestamp tolerance, playable full decode, no unexpected black segments, intended audio duration/levels, safe text layout. Visual QA: silhouette, color, collar/sleeves, button count, logo/print, edge quality and temporal warping. Automated comparisons/vision flags can triage; they do not prove product identity. Source-derived detail shots are the conservative default when confidence is low.

## K. Migration strategy

| Existing code/assets | Disposition |
|---|---|
| eshop routing/auth, static media infrastructure, catalog schema, workspace layout | **Reuse unchanged initially**; extend route allowlist for new job/shot APIs |
| `ffmpeg.ts` probe and basic fixed-argv builders; token-substitution utility and relevant tests | **Reuse unchanged where contracts match**; preserve verified behavior |
| `process-runner.ts` | **Adapt**: stream-bounded capture, cancellation, progress; retain fixed argv/process-group timeout approach |
| Upload middleware | **Adapt**: content decode/pixel limits, staging cleanup, durable asset records, native image-library setup |
| `affiliateVideoJobStore.js` | **Replace implementation** with ID-aware PostgreSQL operations; current global getter/update signatures are insufficient for history and fencing |
| `runAffiliateVideoPipeline.js` | **Adapt** into supervised worker bridge with versioned manifests/events, job IDs, exit/output validation and process-group cancellation |
| `affiliate-video-generate.ts` | **Replace stub internals** with shot renderer/compositor; keep a documented CLI entry point and explicit deterministic test mode |
| `comfyui-provider.ts` | **Adapt transport**: submit/status/cancel/download/reconcile; shot contract, persisted IDs/seed, deadlines, output-node allowlist |
| `types.ts`, `pipeline.ts`, transformation Mastra workflow | **Deprecate for affiliate use**; retain legacy functionality only if needed. Do not force product shots into source-video/character types |
| Bundled pose/character graph | **Deprecate** from default product flow; remove unused outfit node/claims when maintaining legacy path |
| QuickWorkspace | **Adapt after backend**: error distinct from empty, current job by ID, actual stages, shot retry, retained assets/history |
| Scratchpad optical-flow and garment-transfer experiments | **Archive as research** with provenance; do not ship as default or delete evidence |
| Stub-only comments, obsolete route/role grant and unused source-video upload path | **Delete after replacement and usage check**, not during review |
| Historical architecture documents | **Mark superseded by product architecture**, retain measured context; correct conflicting integration claims |

Roll out under an explicit renderer/version flag. New jobs use the durable schema; existing in-memory active job should drain before switching. Do not invent historical job records for loose MP4 files without input provenance; import them as legacy assets only if needed. Keep old published outputs readable. Rollback disables new job admission/optional AI and uses the deterministic renderer; additive tables can remain. No destructive schema migration or code deletion is required to test the new architecture.

## L. Benchmark plan: at most one hour

This is a **planned benchmark**, not executed inference. The initial review already ran plumbing tests/probes. Do not spend the first hour downloading a collection of new video models.

Preconditions: M2/16 GB and software versions recorded; FFmpeg ready; source fixtures available; one candidate model installed if testing it; API credentials/budget if comparing cloud images. If installation is absent, report that candidate untested and use the existing AnimateDiff baseline. Installation time must be reported separately, not hidden in the result.

Use three products: simple solid garment, printed/logo garment, and fine-detail/lace/button garment. Each gets 2–4 source views. Existing blouse assets cover only one narrow case and must not become the entire acceptance dataset.

| Elapsed slot | Work and stop condition |
|---|---|
| 0–5min | Capture hardware, versions, model/node hashes, baseline memory/swap; select reference crops and fidelity rubric |
| 5–15min | Render deterministic 15s control videos at 1080×1920; measure wall time, memory and full-decode output; use them as technical fallbacks/reference, not as the target creative result |
| 15–30min | Generate or evaluate new ComfyUI marketing-keyframe candidates from raw catalog references: wearer/reviewer first if practical, otherwise styled product-commercial scenes. One still profile at a time; record model/graph hash, load time, inference time, MPS/free memory and swap delta. Remote output may be retained only as a comparison artifact. |
| 30–45min | At most two sequential ComfyUI local I2V trials, max 8min each plus cleanup: existing short AnimateDiff and small LTX 2B if ready; use an accepted marketing keyframe/reference pack, fixed seed/profile. Stop at OOM or sustained severe memory pressure. |
| 45–50min | Probe/decode actual outputs, capture representative frames, compare garment details to raw references and record runtime/resource results; no production recovery work |
| 50–60min | Compose the best accepted generated scenes into a 15s video, using deterministic source-photo shots only as fallback/reference cut-ins. Inspect first/middle/last frames and playback; summarize decision |

Use a small throwaway benchmark runner, not a production refactor. Worker restart, persistence, stale-result fencing and duplicate-submission tests are deferred to Phases 1 and 6 after user approval.

Score product fidelity (silhouette/color/fabric/details/logo), scene credibility, human/wearer plausibility where attempted, temporal stability and marketing appeal on explicit five-point rubrics. Critical failures—wrong logo, missing defining buttons, mutated cut, wrong garment type, implausible worn fit, or obvious AI body/hand artifacts—reject regardless of average score. Compare both still crops and normal-speed playback; record human preference without claiming statistical significance from three products.

**Decision gates:** the generated-scene version must pass technical export, product fidelity and marketing-content quality. The deterministic version must pass as a fallback/control, but it does not satisfy the product goal by itself. Enable a local video renderer only if a complete two-second shot fits its eight-minute allocation without OOM/severe swap and improves the final video without a fidelity regression. Passing once permits an experiment, not a reliability promise; follow with at least ten representative runs including cold/warm starts before enabling by default. If generated human modeling fails, pivot to non-worn commercial product scenes before calling the attempt unsuccessful.

Report median/range and all failures for the tiny test; do not label a two-sample maximum “p95.” The benchmark answers whether more investment is justified, not whether production performance is established.

## M. Implementation plan — revised renderer-first order

Authorized order: **Phase 0 → Phase 2 → Phase 3 → Phase 4 → USER APPROVAL → Phase 1 → Phase 5 → Phase 6**.

Current standalone scope is **Phases 0–4**. The immediate deliverable is a real standalone 15-second generated-scene video from 2–4 product images, measured on the M2 and available for visual review, plus a clear record that raw-photo output is only a technical control/fallback. No database integration, durable jobs, workspace UI, or production-flow changes are authorized yet.

1. **Phase 0 — isolated reference/control benchmark (complete).** A throwaway CLI experiment, source manifest, raw-photo control MP4, bounded local AI comparison if feasible, measured runtime/resources, output probes, visual review artifacts and limitations. Use available product images; explicitly report that a raw-photo pan/zoom result is not the intended creative target. No production worker/recovery implementation or restart testing.
2. **Phase 2 — standalone product reference pack + technical fallback renderer (complete).** Turn benchmark lessons into a reusable local CLI consuming 2–4 raw catalog images, crop/detail/reference metadata and a 15s timeline. Produce a 1080×1920 technical fallback/control video with controlled motion, text/CTA and optional audio, and emit the product-reference evidence needed by Phase 3. File manifests only; no production job IDs or database dependency. Acceptance: reliable decode/export, clear product evidence, reproducible manifests and a fallback video that is acceptable only when generation fails.
3. **Phase 3 — essential standalone ComfyUI marketing keyframe/scene generation.** Use bounded ComfyUI still profiles to transform raw catalog photos into new marketing scenes while preserving garment identity. First preference: believable wearer/reviewer scenes. Fallback: premium product-commercial scenes that still look newly generated. Treat any remote generator as a comparison baseline only. Store graph/model hashes, input/output/usage, M2 timing, memory and swap measurements in files. No workspace integration. Acceptance: enough accepted ComfyUI-generated scenes to make the video look like marketing content rather than animated catalog uploads, without an unacceptable resource cost per accepted shot.
4. **Phase 4 — standalone ComfyUI local AI motion benchmark.** Apply benchmark-approved ComfyUI video profiles only to accepted generated scenes/reference packs, with bounded inference and local comparison artifacts. Measure the expensive M2 path separately: cold/warm load, inference/download time, unified-memory/swap movement and accepted motion quality. Keep the deterministic fallback usable when AI adds no value. Benchmark the complete generated-scene video and present it with source comparisons.

**Explicit approval gate:** the user reviews and approves the generated video quality AND architecture before any of the following phases begin. Passing technical checks, producing an MP4, or waiting for a reply does not constitute approval.

5. **Phase 1 — production durable job/assets/shot foundation (deferred).** Integrate the proven renderer with PostgreSQL, leases/fencing, idempotency, durable attempts and recovery. Do not constrain the renderer experiment around these abstractions beforehand.
6. **Phase 5 — workspace progress/recovery UI (deferred).** Integrate current-job hydration, actual shot/stage progress, reuse/history/retry/cancellation only after production contracts exist.
7. **Phase 6 — production acceptance/hardening/cleanup (deferred).** Crash/restart/timeout/OOM and ambiguous-submission recovery, operational metrics, retention, deployment and legacy cleanup.

Sections I–K describe deferred architecture, not current implementation scope. Phase 0 uses local experiment manifests and metrics only. Run Phase 2/3/4 separately after the Phase 0 outcome is reviewed; production integration remains gated on explicit final video/architecture approval.
