# Local video transformation pipeline

A local, video-to-video character/outfit transformation pipeline: given a
source video of a person, a reference character image, and an optional
outfit reference image, it produces a new video where the original motion,
pose, timing, camera movement, and background are preserved as closely as
practical, while the person's appearance is steered toward the reference
character and clothing.

**This is an MVP, not a production feature.** It is a thin, swappable
orchestration layer around an external local AI backend (ComfyUI by
default) that does the actual generation. Read "Current limitations" before
relying on it for anything beyond experimentation.

**Responsible use.** This pipeline changes how a real person appears in
video they were filmed in. Only run it on footage you have the rights and
consent to alter, and be transparent about synthetic media you produce with
it. It is not built to evade content moderation, provenance/watermarking,
or platform detection systems, and should not be adapted to do so.

## Ownership and the eShop contract

This pipeline is a **product integration** (eShop affiliate video), not part of the engineering runtime. It stays in this repository, under `src/integrations/video/` and `scripts/video-transform.ts`, until it is migrated into the eShop repository.

The eShop admin API (`src/modules/workspace/api/generateVideo/[multerFile]handle[auth].js`) runs `scripts/video-transform.ts` as a child process with `cwd = $VIDEO_PIPELINE_DIR`. That CLI path and its flags are the compatibility contract; do not change them without changing the eShop.

**Required eShop change before the checkout is renamed or moved:** that file falls back to a hard-coded absolute path when `VIDEO_PIPELINE_DIR` is unset. Either set `VIDEO_PIPELINE_DIR` to the checkout in the eShop environment (no code change), or replace the fallback with a relative/required setting. Nothing in this repository depends on the checkout location or the user's home directory.

## Architecture

```
source video
    |
video preprocessing        (ffprobe: duration/fps/resolution/audio)
    |
frame extraction            (ffmpeg: fps + resolution normalized, aspect preserved)
    |
character/outfit conditioning \
video generation                > delegated to a VideoTransformationProvider
temporal consistency          /
    |
frame reconstruction         (ffmpeg: frames -> silent mp4)
    |
audio mux                    (ffmpeg: original audio track muxed back in)
    |
MP4 output
```

Code layout:

- `src/integrations/video/types.ts` - `VideoTransformationProvider` interface,
  input/output/metadata types, `VideoTransformError` (typed error codes).
- `src/integrations/video/config.ts` - all backend/tooling configuration, read
  from environment variables (see below). Nothing is hardcoded.
- `src/integrations/video/ffmpeg.ts` - `probeVideo`, `extractFrames`,
  `assembleVideo`, `muxAudio`. Command-argument construction is a pure,
  separately-tested function; execution goes through
  `src/integrations/video/process-runner.ts` (fixed argv, never a shell string,
  hard timeout, same shape as this repo's existing
  `execution-tools.ts`).
- `src/integrations/video/validate.ts` - input validation (files exist, correct
  extensions, ffmpeg available, best-effort disk space check).
- `src/integrations/video/providers/` - `VideoTransformationProvider`
  implementations:
  - `comfyui-provider.ts` - HTTP client for a locally running ComfyUI
    instance. ComfyUI itself is **not** vendored into this repo - it's
    treated as an external local service this adapter talks to.
  - `comfyui-workflow.sample.json` - a sample ComfyUI graph (see below).
  - `mock-provider.ts` - a no-op provider (passes frames through
    unchanged) used by the test suite and available as
    `VIDEO_AI_BACKEND=mock` for dry runs without ComfyUI.
- `src/integrations/video/pipeline.ts` - orchestration:
  `prepareVideo` -> `runVideoTransformation` -> `assembleOutput`. Shared by
  the CLI and the Mastra workflow so both behave identically.
- `src/integrations/video/mastra-workflow.ts` - a Mastra
  workflow (`validate-input` -> `prepare-video` ->
  `run-video-transformation` -> `assemble-output`) wrapping the same
  pipeline functions, registered in `src/integrations/mastra/index.ts`. Deliberately a
  straight-line chain: no branching, retries, queues, or parallel workers.
- `scripts/video-transform.ts` - the developer CLI
  (`npm run video:transform`).

## Why ComfyUI

The task needs a backend that transforms an *existing* video's content
while preserving its motion, not a text/image-to-video generator that
produces an unrelated clip. As of this writing, the most practical local,
open-source way to do that is a ComfyUI graph combining:

- **ControlNet (pose)** on the source frames, to keep the generated output
  following the source video's actual pose/motion per frame.
- **IP-Adapter** conditioned on the character reference image, to steer
  face/hair/appearance.
- **AnimateDiff** (or an equivalent motion module) for temporal
  consistency across frames, so the output doesn't flicker frame-to-frame.
- **VideoHelperSuite** to load/combine frame sequences.

This is exactly what `comfyui-workflow.sample.json` wires up. ComfyUI was
chosen over a single bundled model because no single current open-source
checkpoint does "video-to-video with pose-preserving motion + reference
face + reference outfit" end-to-end - a node graph lets you combine
purpose-built models for each concern, and swap any of them later.

## Local setup

### 1. ffmpeg

```
brew install ffmpeg
```

Verify: `ffmpeg -version` and `ffprobe -version`. Override the binaries
used via `FFMPEG_BIN`/`FFPROBE_BIN` if they're not on `PATH`.

### 2. ComfyUI (only needed for `VIDEO_AI_BACKEND=comfyui`, the default)

Install and run ComfyUI locally per its own documentation
(https://github.com/comfyanonymous/ComfyUI) - it is **not** installed or
managed by this repository. On Apple Silicon it runs via PyTorch's MPS
backend:

```
git clone https://github.com/comfyanonymous/ComfyUI
cd ComfyUI
pip install -r requirements.txt
python main.py   # serves http://127.0.0.1:8188 by default
```

You will also need, at minimum, for the sample workflow specifically:

- A base checkpoint (e.g. a Realistic Vision / SD1.5-class model)
- An AnimateDiff motion module (`ComfyUI-AnimateDiff-Evolved`)
- An OpenPose ControlNet model + preprocessor (`comfyui_controlnet_aux`)
- IP-Adapter models + loader (`ComfyUI_IPAdapter_plus`)
- `ComfyUI-VideoHelperSuite` for frame loading/combining
- A custom "load image from absolute path" node, since the sample
  workflow points at this pipeline's own temp files (any of several
  community node packs provide this - e.g. the "Load Image (Path)"
  node types)

**None of this is verified working end-to-end on this machine** (no GPU
model was run here - see "Current limitations"). Treat
`comfyui-workflow.sample.json` as a documented starting point, not a
tested graph. `COMFYUI_WORKFLOW_PATH` lets you point at your own graph
once you've built/validated one, using the same `{{TOKEN}}` placeholders
(see the top of `comfyui-provider.ts`).

### 3. Environment variables

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Meaning |
|---|---|---|
| `VIDEO_AI_BACKEND` | `comfyui` | `comfyui` or `mock` |
| `COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | ComfyUI server address |
| `COMFYUI_WORKFLOW_PATH` | bundled sample | Path to a ComfyUI workflow JSON template |
| `COMFYUI_TIMEOUT_MS` | `1200000` (20 min) | Max time to wait for a run to complete |
| `COMFYUI_POLL_INTERVAL_MS` | `2000` | History-polling interval |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | Override binary paths |
| `VIDEO_WORKDIR` | `.workdir/video-transform` | Base dir for per-run scratch space |
| `VIDEO_MAX_FPS` | `24` | FPS cap applied during preprocessing |
| `VIDEO_MAX_DIMENSION` | `768` | Longest-side pixel cap, aspect ratio preserved |
| `VIDEO_MIN_FREE_DISK_BYTES` | `524288000` (500MB) | Best-effort free-space check before starting |
| `FFMPEG_TIMEOUT_MS` | `300000` (5 min) | Per-ffmpeg-command timeout |

## Running it

### CLI

```
npm run video:transform -- \
  --video ./input/source.mp4 \
  --character ./input/character.jpg \
  --outfit ./input/outfit.jpg \
  --output ./output/result.mp4 \
  --appearance-variation subtle
```

Flags: `--video`, `--character`, `--output` are required. `--outfit` and
`--prompt` are optional. `--appearance-variation none|subtle` (default
`subtle`). `--fps` and `--max-dimension` override the env defaults for a
single run.

Try it without any AI backend first:

```
VIDEO_AI_BACKEND=mock npm run video:transform -- --video ./input/source.mp4 --character ./input/character.jpg --output ./output/result.mp4
```

This exercises the full ffmpeg preprocessing/reassembly/audio-mux pipeline
with a pass-through provider - useful for confirming your ffmpeg install
and input files are good before involving ComfyUI.

### Mastra workflow

Registered as `videoTransformationWorkflow` in `src/integrations/mastra/index.ts`.
Run it via Mastra Studio (`npm run dev`, select the workflow, and pass the
same fields as the CLI as `inputData`), or programmatically:

```ts
import { videoTransformationWorkflow } from './src/integrations/video/mastra-workflow.ts';

const run = await videoTransformationWorkflow.createRun();
const result = await run.start({
  inputData: {
    sourceVideo: './input/source.mp4',
    characterReference: './input/character.jpg',
    outfitReference: './input/outfit.jpg',
    outputPath: './output/result.mp4',
    appearanceVariation: 'subtle',
  },
});
```

## Expected input/output

**Input:** a source video (`.mp4`/`.mov`/`.m4v`/`.webm`/`.avi`/`.mkv`)
containing a person; a character reference image
(`.jpg`/`.jpeg`/`.png`/`.webp`); optionally an outfit reference image
(same formats).

**Output:** an `.mp4` at the requested path, matching the source's
duration and (FPS/resolution capped by `VIDEO_MAX_FPS`/
`VIDEO_MAX_DIMENSION`, aspect ratio preserved) with the source's original
audio track muxed back in if it had one. `metadata` on the result reports
the backend used, source/output fps/resolution/duration, frame count, the
appearance-variation setting, and the (already-cleaned-up-on-success)
working directory.

## Current limitations

- **Not verified against a real ComfyUI run.** This machine has no
  CUDA/large-VRAM GPU available in this session; only the `mock` backend's
  frame-passthrough path and the ffmpeg preprocessing/reassembly/audio-mux
  path were exercised end-to-end here (see `ffmpeg.itest.ts` and a manual
  `VIDEO_AI_BACKEND=mock` run). The ComfyUI HTTP adapter's request/response
  handling is unit-tested against a mocked `fetch`, but the sample workflow
  graph itself has not been run.
- **Apple Silicon / unified-memory performance.** Diffusion + ControlNet +
  IP-Adapter + AnimateDiff per frame is heavy. On an M-series Mac via
  PyTorch MPS, expect this to be dramatically slower than an NVIDIA GPU
  with equivalent VRAM, and to need a lower-resolution/shorter clip
  (`VIDEO_MAX_DIMENSION`, `VIDEO_MAX_FPS`, and trimming the source video)
  to complete in a reasonable time. 8GB of unified memory is unlikely to
  be enough for the full sample stack; 16GB+ is a more realistic floor,
  and even then, expect minutes per second of output video, not real time.
- **Temporal consistency is model-stack-dependent, not guaranteed by this
  code.** AnimateDiff-style motion modules reduce flicker but don't
  eliminate it; longer clips are more prone to drift. This pipeline does
  not implement its own frame-interpolation or consistency post-pass.
- **Outfit transfer is the weakest-supported part of this MVP.** The
  sample ComfyUI graph conditions on the outfit reference only through a
  second IP-Adapter-style pass in the same graph, which is a soft
  approximation, not a proper virtual try-on model (e.g. IDM-VTON,
  OOTDiffusion). Those models are built for single garment-on-person
  images, not motion video, and integrating one for per-frame video is
  out of scope for this MVP. Expect outfit conditioning to be
  unreliable, especially for identity-specific garment details
  (patterns, logos, exact cut).
- **Face variation is a single coarse knob.** `appearanceVariation:
  "subtle"` lowers IP-Adapter conditioning strength slightly to leave
  the diffusion pass room to diverge from the reference photo; it is not
  a calibrated or validated identity-distance control.
- **No retries, queues, or durable execution.** A failed run must be
  re-invoked from scratch; there is no checkpoint/resume. This is
  intentional for the MVP (see project constraints), not an oversight.
- **Single-machine, single-run.** No concurrency control between runs
  sharing `VIDEO_WORKDIR`; each run gets a UUID subdirectory, but nothing
  stops two runs from being started at once and competing for the same
  ComfyUI instance/GPU.

## What's model/backend-specific vs. reusable

Reusable regardless of backend: everything in `src/integrations/video/` except
`providers/comfyui-provider.ts` and
`providers/comfyui-workflow.sample.json` - `types.ts`, `config.ts`,
`ffmpeg.ts`, `validate.ts`, `pipeline.ts`, the Mastra workflow, and the
CLI all operate purely in terms of the `VideoTransformationProvider`
interface.

Backend-specific: the ComfyUI provider and its workflow template. To swap
in a different backend (a native video diffusion model's own API, a
virtual try-on service, etc.), implement `VideoTransformationProvider`
(one `transform()` method) and add a `case` to
`src/integrations/video/provider-factory.ts` - nothing else in the pipeline
needs to change.
