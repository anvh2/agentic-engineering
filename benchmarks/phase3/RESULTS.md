# Phase 3 review-cut results — 2026-09-27

## Review video

- [Generated-scene review MP4](run-01/generated-scene-review-15s.mp4)
- [Contact sheet](run-01/generated-scene-review-contact-sheet.jpg)
- [Technical probe](run-01/generated-scene-review-probe.json)
- [Timing and limitations](run-01/metrics.json)

The review cut is a valid H.264/yuv420p vertical export: 1080×1920, 30 fps,
450 decoded frames, and 15.000000 seconds. Full FFmpeg decode passed. The
local composition portion took 32.99 seconds after generated stills existed.

## Candidate decisions

| Candidate | Decision | Evidence |
|---|---|---|
| `wearer-hero-v1-rejected.png` | Rejected | It is a convincing new lifestyle scene, but it visibly loses part of the required flower-button/collar construction. |
| `product-commercial-v1-conditional.png` | Conditional | New premium product scene, correct color, loose silhouette, pintucks and three flower buttons. Collar layering and cuff construction still need closer comparison to the source evidence. |
| `construction-macro-v1-conditional.png` | Conditional | New detail scene showing three flower buttons, pintucks, yoke ruffle, color and puffed sleeve/cuff. It needs human review for exact collar-layer construction. |

The review video uses only the two conditional generated scenes. No raw
catalog image is used as a final video frame. It deliberately repeats those
two scenes as five editorial shots, so it is suitable for judging the
generated-scene direction but is not yet a diverse five-scene production
sequence. These remote-generated candidates are a quality comparator only;
they are not the selected production renderer.

## Current limitation and next evidence

The person-wearing direction has not met the identity gate in one attempt.
The product-commercial fallback is more faithful and is the safer current
direction. The selected implementation focus is now bounded ComfyUI still
generation, measured by M2 model-load/inference time, memory/swap growth and
accepted-shot rate. Phase 4 local AI motion remains unproven: the Phase 0 M2
AnimateDiff trial was stopped by the memory/swap resource gate and produced
no usable clip. This review cut therefore uses restrained deterministic
motion over accepted generated scenes; it does not claim natural fabric or
camera motion.
