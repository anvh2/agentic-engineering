# Phase 2: product reference pack and fallback control renderer

This is a standalone, file-based Phase 2 utility. It converts 2–4 raw
product photos into an immutable-hash reference manifest, renderer previews,
a reference board, a five-scene Phase 3 brief, and a technically valid
15-second 1080×1920 fallback/control MP4.

The generated fallback is deliberately labelled as source evidence. It is
useful for validating inputs, timing, output encoding, and a last-resort
publishable control. It does **not** satisfy the product goal by itself:
Phase 3 must create and accept new wearer/reviewer or premium
product-commercial keyframes from this pack.

Run the blouse fixture from the harness repository:

```sh
node benchmarks/phase2/build.mjs \
  --reference benchmarks/phase2/blouse-reference.json \
  --output benchmarks/phase2/run-01 \
  .workdir/quick-video/scratchpad/comfy-affiliate-v1/assets/ref/overview_3.png \
  .workdir/quick-video/scratchpad/comfy-affiliate-v1/assets/ref/detail_3.png \
  .workdir/quick-video/scratchpad/comfy-affiliate-v1/assets/ref/overview_1.png
```

For another product, provide a manually reviewed reference JSON modeled on
`blouse-reference.json`. Do not infer unverified material, price, brand, or
unseen construction details from pixels. The utility requires Node, FFmpeg,
and the already-installed sibling `eshop` Sharp dependency. It does not call
cloud APIs, invoke ComfyUI, install models, or write application data.
