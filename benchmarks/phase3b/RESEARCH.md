# Phase 3B — garment-preserving / virtual try-on research and prep

**Status: research + architecture only. No models downloaded, no inference run.**
This document is the deliverable for Phase 3B steps 1–9. It does not touch
Phase 1/5/6 or any production UI/database code, and it does not start Phase 4.

## 1. Why Phase 3 (SD1.5 + IPAdapter txt2img) failed

The rejected run (`benchmarks/phase3/comfy-run-01/`) used `IPAdapterAdvanced`
to condition a full txt2img generation on the garment photo. IPAdapter is a
**style/content conditioning adapter** — it nudges the diffusion process
toward the reference image's look (color palette, general vibe, texture
style) via CLIP-vision embeddings injected into cross-attention. It has no
garment-warping, no agnostic-person mask, and no explicit spatial mapping
from "this is the garment's actual silhouette/geometry" to "this is where it
must land on the body." With `denoise=1.0` the model is free to reinvent the
entire image from noise, constrained only by that soft style signal — which
is exactly what happened: the geometry (blouse → dress, new waist/tie,
changed placket) drifted because nothing in the graph was ever telling it
*not* to.

Virtual try-on (VTON) models are architecturally different: they take a
**person image**, a **garment-agnostic mask** (the region where the old
garment is removed), and the **garment image**, and are trained specifically
to warp/paint the garment onto the masked region while preserving the
garment's own geometry. That is the class of model this phase needs, not a
bigger IPAdapter weight or a lower CFG.

## 2. What's already on this machine (inspected, not assumed)

- **ComfyUI**: v0.37.0, local, MPS backed (`mps` device, 16 GiB unified
  memory total, ~6.2 GiB free at inspection time), `--enable-manager`.
- **Installed custom node packs** (`custom_nodes/`): `ComfyUI-Advanced-ControlNet`,
  `ComfyUI-AnimateDiff-Evolved`, `ComfyUI-VideoHelperSuite`,
  `ComfyUI_IPAdapter_plus`, `comfyui-sam2`, `comfyui_controlnet_aux`. **No
  VTON-specific node pack is installed.**
- **`comfyui-sam2` is already fully installed with weights** —
  `models/sam2/sam2_hiera_tiny.pt` and
  `models/grounding-dino/groundingdino_swint_ogc.pth` are present on disk
  (there's even a prior output, `video-transform-v3-sam2-final_*`, showing
  it's been exercised before). This matters: SAM2 + GroundingDINO is exactly
  what's needed to auto-generate a **garment-agnostic mask** from a text
  prompt (e.g. "shirt, blouse, top") with **zero new downloads**.
- **Checkpoints**: only `realisticVisionV60B1.safetensors` (SD1.5). No
  SDXL checkpoint installed.
- **ControlNet**: SD1.5 depth + openpose only.
- **Disk**: 39 GiB free on the ComfyUI volume (460 GiB total, already 91%
  used) — enough for a ~5–8 GiB VTON model add, not enough to casually add
  several multi-GB SDXL-class model sets.
- **Machine**: Apple M2, 16 GiB **unified** memory (shared between OS, GPU,
  and model weights/activations — not a dedicated-VRAM GPU). Phase 0 already
  found this machine's conservative resource gate trips under a comparatively
  *light* SD1.5 + AnimateDiff + IPAdapter load (384×512, 16 frames): swap grew
  ~2.0→4.9 GiB in ~60s. That result is the binding constraint for every
  option below — single-image inference at moderate resolution is fine
  (Phase 3's txt2img run itself completed the SD1.5 forward passes without
  incident; it failed on *fidelity*, not compute), but anything requiring a
  second full-size UNet in memory simultaneously, or SDXL-scale weights,
  is the kind of load that already tripped this machine's gate once.
- **No existing "person/reviewer" base photo.** The image at
  `ComfyUI/input/approved_hero_frame1.png` was checked and is a garment
  close-up (not a person) — it cannot serve as a VTON base image. A neutral
  person base still needs to be produced or sourced (see §6).

## 3. Candidate approaches

| Approach | Architecture | Download size (est.) | Peak memory profile | MPS/Apple Silicon | Garment-fidelity design intent |
|---|---|---|---|---|---|
| **CatVTON** | Lightweight diffusion VTON built on an SD1.5 **inpainting** UNet + added attention modules. Only 899M total params, 49.6M of them trainable — the base UNet is standard SD1.5 architecture, everything is added, not swapped for something exotic. Mask-based (a `CatVTON-MaskFree` variant also exists, needing no explicit mask). | ~5–6 GiB (SD1.5-inpainting base + CatVTON attention weights) | **Single** UNet forward pass per step, batch=1, no temporal dimension — the lightest of the three by a wide margin. Upstream reports <8 GiB VRAM at 1024×768 on a *dedicated*-VRAM GPU. | Standard diffusers ops (UNet/attention/VAE) — same op family as the SD1.5 checkpoint already proven to run on this machine's MPS backend in Phase 0/3. No confirmed first-party Apple Silicon report found, but no exotic/CUDA-only ops either. | Purpose-built for clothing transfer; explicitly trained to preserve garment geometry via the agnostic-mask + garment-image conditioning, not a style nudge. |
| **OOTDiffusion** | Two full SD1.5-sized UNets: `unet_garm` (garment encoder branch) + `unet_vton` (main denoising branch, receives garment features via attention). | `unet_garm` alone measured at 3.2 GiB; `unet_vton` is comparably sized (~3–3.5 GiB) → **~7–9 GiB total** across both UNets + shared SD1.5 VAE/CLIP. | **Two** UNets resident and doing forward passes per step (roughly double the compute *and* memory of a single-UNet SD1.5 run), still single-image/no temporal dimension. This is architecturally closer to the load class that already stressed this machine once, just without AnimateDiff's 16-frame batch — net memory is hard to predict without testing. | Same diffusers op family as CatVTON; no confirmed Apple Silicon report found. | Also purpose-built for outfitting/try-on; published results emphasize garment-detail retention (their whole framing is "outfitting fusion"), a credible second choice. |
| **IDM-VTON** | SDXL-based: full SDXL UNet + a second near-duplicate "IP-Adapter-style" garment UNet encoder branch, plus SDXL's larger text encoders. | SDXL-scale — realistically 12–15+ GiB across both UNet copies and encoders. | Upstream documentation states **≥16 GiB VRAM required**, on a dedicated-VRAM GPU with no OS/other-process contention. This machine has 16 GiB **total, shared** unified memory — there is no headroom margin at all, let alone the margin Phase 0 showed this machine needs before it starts swapping. | SDXL MPS support exists in general, but at this model's stated minimum requirement the risk of hitting the same swap/OOM gate Phase 0 hit — this time with a much bigger working set — is high. | Currently the highest-fidelity published VTON result of the three, but not usable here without a hardware upgrade. |

**Ruled out: IDM-VTON.** Its own stated minimum (16 GiB VRAM) leaves zero
margin on a 16 GiB *unified*-memory machine that already needed a
conservative resource-stop once under a lighter load. Not worth the download
or the risk.

## 4. Recommendation: CatVTON

CatVTON is the one experiment to prepare:

- Smallest download (~5–6 GiB vs. OOTDiffusion's ~7–9 GiB), smallest memory
  footprint (single UNet, 899M added params) — the best fit for a 16 GiB
  unified-memory machine that has already shown its resource ceiling once.
- Architecturally a standard SD1.5 inpainting UNet plus attention layers —
  same op family already proven to execute on this machine's MPS backend.
- Purpose-designed for exactly this task (garment transfer with geometry
  preservation), unlike Phase 3's IPAdapter misuse.
- The agnostic-mask step it needs can be produced **entirely from
  already-installed, already-weighted nodes** (`comfyui-sam2` +
  GroundingDINO) — no extra download for that half of the pipeline.
- Two independent ComfyUI wrapper node packs already exist and are
  maintained: `pzc163/Comfyui-CatVTON` and `chflame163/ComfyUI_CatVTON_Wrapper`.

OOTDiffusion is the documented fallback if CatVTON's fidelity or MPS
behavior disappoints in the first real test — same op family, moderately
higher memory cost, not run first because CatVTON is strictly lighter and
sufficient to test the architecture class before spending the larger
download/memory budget.

## 5. Open item this plan does not resolve: the person base image

VTON needs a **person/reviewer photo** to try the garment onto. None exists
in this repository or in ComfyUI's `input/` directory today (verified by
inspection, see §2). Two options, for the user to choose before step 1 of
the run plan below:

- **(a) Generate a neutral synthetic person base** with the already-working
  SD1.5 txt2img pipeline (no garment involved, so none of Phase 3's
  fidelity problem applies — a plain-clothed, front-facing, waist-up figure
  in neutral lighting is a well-trodden SD1.5 task). Avoids any real-person
  likeness/consent question. This is the default recommendation.
- **(b) Supply a real or stock photo** of a person, if the user has one
  licensed for this use.

Not decided here — flagging for approval alongside the rest of this plan.

## 6. Exact installation/run plan (NOT executed — for approval)

All commands below are to be run manually after approval; none have been run
by this task.

### Step 1 — install the CatVTON custom node

```sh
cd /Users/anvh/Documents/comfy/ComfyUI/custom_nodes
git clone https://github.com/pzc163/Comfyui-CatVTON.git
cd Comfyui-CatVTON
pip install -r requirements.txt   # inside ComfyUI's own venv/environment
```

(`chflame163/ComfyUI_CatVTON_Wrapper` is the documented fallback if this one
has install friction on macOS/MPS.)

### Step 2 — first-run model download (triggered by the node itself)

CatVTON's node downloads its weights (SD1.5-inpainting base + CatVTON
attention modules, zhengchong/CatVTON on Hugging Face) on first workflow
execution — reported to take "dozens of minutes." This is the multi-GB
download step Phase 3B is explicitly not allowed to trigger yet; it happens
only after approval, at the start of the real experiment.

### Step 3 — restart ComfyUI so the new node registers

```sh
comfy launch
```

Then confirm via the object_info catalog (no inference, read-only):

```sh
comfy --json nodes search "CatVTON"
```

### Step 4 — produce the two real inputs

1. Garment reference: reuse the already-verified, hash-checked
   `overview_3.png` (same file Phase 0/2/3 used).
2. Person base image: per §5, either generate via a plain SD1.5 txt2img
   graph (no garment conditioning — this repo's existing checkpoint is
   sufficient) or receive a supplied photo.

### Step 5 — generate the garment-agnostic mask locally, no new downloads

Using the already-installed `comfyui-sam2` + GroundingDINO: GroundingDINO
text-grounds the person image on a prompt like `"shirt, blouse, top"` →
bounding box → SAM2 segmentation → binary agnostic mask. This produces the
third CatVTON input without touching the network.

### Step 6 — one bounded CatVTON trial

A single-image graph: `person image` + `agnostic mask` + `garment image` →
CatVTON node → one output image. Same bounded-trial discipline as
`benchmarks/phase3/comfy_still_trial.py` (single submission, poll
`/history` outside any LLM loop, sample memory/swap, conservative swap/RAM
resource-stop, persist prompt id + graph + timing + errors + the output
image) — to be built as `benchmarks/phase3b/comfy_catvton_trial.py`,
mirroring the existing script's structure, once this plan is approved.

### Step 7 — fidelity comparison

Compare the CatVTON output against the same protected-detail checklist used
in Phase 2/3: collar, sleeves/cuffs, buttons/placket, ruffles/pintucks,
color, fabric, print/logo. Record accept/reject the same way
`benchmarks/phase3/RESULTS.md` did for the rejected run, plus disk/swap/RAM
figures actually observed (vs. the estimates in §3).

## 7. Explicitly not done in this task

- No model weights downloaded.
- No custom node installed.
- No inference run.
- No changes to Phase 1/5/6, production UI, or database code.
- No changes to the existing (rejected) `benchmarks/phase3/` artifacts —
  left as the record of what didn't work and why.

**Stopping here for approval**, per the task's instruction, before Step 1
of §6 is executed.
