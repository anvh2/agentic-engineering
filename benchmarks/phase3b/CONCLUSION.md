# Phase 3B conclusion: reject CatVTON for this product

Decision: **B — no further CatVTON mask trial is justified. Do not run C4.**

The C3 garment preprocessing preserved the complete reference blouse: sleeves,
rounded collar, placket/buttons, chest ruffle/pintucks, silhouette, and fabric
were all visible. Person preprocessing was also valid. The mask supplied to C3
already exposed a wide shoulder and upper-arm region, yet the completed output
still removed or malformed the sleeves, cropped the blouse silhouette, smeared
the chest construction, and lost most buttons/placket detail. Those defining
features were already inside the repaint region, so lack of mask space is not a
strong explanation for their loss.

The later unexecuted C4 draft mainly widens and shortens the lower torso/hem
region. It does not explain or directly solve C3's failure to reproduce details
inside the already-exposed collar, chest, and sleeve regions. Its mask remains
mechanically composed from broad rectangular bands. Continuing to tune that
geometry would be speculative optimization of CatVTON rather than evidence for
the marketing-video product.

## Verification

- `py_compile` passed for the Phase 3B mask, CatVTON, person-base, and graph
  modules.
- Relevant unit suite: 83 tests executed; 76 passed and 7 failed. The failures
  are confined to the partially edited C4 hem/taper behavior no longer matching
  its existing contracts. They are recorded as evidence of unfinished mask
  drift, not repaired because C4 is rejected.
- Existing mask artifacts were visually inspected:
  `catvton-agnostic-mask.png`, `mask-preflight-overlay.png`, and
  `mask-summary.json`.
- The intentional `CATVTON_DEBUG_STOP` remains in the local CatVTON node. There
  is no reason to remove it or restart ComfyUI because no further CatVTON
  inference is approved.
- No diffusion inference was run during this decision.

## Next experiment

Evaluate one stronger **local ComfyUI** reference-preserving image-generation
or image-editing architecture. OpenAI may guide shot planning, prompts, and
quality-review criteria, but the worker must execute image generation locally
through ComfyUI to control provider cost. Do not install, download, or benchmark
the replacement model as part of this handoff.

There is no manual C4 command: CatVTON is rejected after C3.
