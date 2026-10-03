# Phase 3B artifact provenance

Recorded 2026-10-03 during repository recovery. Read this before trusting any
JSON under `comfy-run-01/catvton/`.

## The run metadata in `catvton/` is NOT from the C3 run

`comfy-run-01/catvton/{metrics,history,graph,submission,environment}.json` were
written on 2026-09-28 22:31–22:32 by a later **preprocessing debug run**. That
run deliberately raised `CATVTON_DEBUG_STOP: preprocessed inputs exported;
inference intentionally skipped` inside the local CatVTON custom node, so the
files report `status: failed` after ~20 seconds. The exported preprocessed
inputs from that run are in `../../catvton-debug/`.

That debug run reused the C3 output directory and overwrote the C3 run's
metadata. Reading only these JSON files leads to the wrong conclusion that C3
never executed.

## What actually happened

| Time (local) | Event | Surviving evidence |
|---|---|---|
| 2026-09-27 22:28–22:34 | Person base images generated | `comfy-run-01/person-base/*.png`, `history.json` |
| 2026-09-27 23:19 | Earlier CatVTON output (purpose uncertain, likely a pre-C3 attempt) | `catvton/phase3b-catvton-6792f837_00001_.png` |
| 2026-09-27 23:42 | **C3 completed at runtime** | `catvton/phase3b-catvton-aa53051e_00001_.png` |
| 2026-09-28 22:31 | Debug run overwrote `catvton/*.json` (see above) | `catvton/*.json`, `../../catvton-debug/*.png` |
| 2026-09-28 22:52 | Mask artifacts regenerated for the unexecuted C4 draft | `comfy-run-01/mask/*` |
| 2026-09-28 23:16 | Decision: reject CatVTON, no C4 | `CONCLUSION.md` |

## C3 outcome

Runtime success, product failure. The C3 output removes or malforms the
sleeves, crops the blouse silhouette, smears the chest construction, and loses
most buttons/placket detail. See `CONCLUSION.md`.

## External state

The `CATVTON_DEBUG_STOP` edit still lives in the external ComfyUI install
(`custom_nodes/Comfyui-CatVTON/__init__.py`), outside this repository. It was
intentionally left in place; no further CatVTON inference is approved.
