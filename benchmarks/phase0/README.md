# Phase 0: standalone video quality benchmark

Only experiment scripts and artifacts live here. No production renderer, database, durable job, API route or workspace UI is changed.

Implementation order is **0 → 2 → 3 → 4 → user approval of actual video and architecture → 1 → 5 → 6**. This directory executes Phase 0 only. See [the revised plan](../../ARCHITECTURE_REASSESSMENT.md#M-implementation-plan--revised-renderer-first-order).

The baseline consumes three existing photos of one blouse, hashes the originals, builds five source-photo motion shots, uses restrained zoom and four short dissolves, and exports 15 seconds at 1080×1920/30 fps. Typography is an SVG overlay rendered with the existing eshop Sharp installation. Unlike the historical install-script concern, the currently installed Sharp binary was verified to load successfully on this Mac.

Run from the harness repository:

```sh
node benchmarks/phase0/render.mjs benchmarks/phase0/run-02
```

Requires local FFmpeg/ffprobe, Node, sibling eshop's installed Sharp, and the existing reference files identified in the script. `/usr/bin/time -l` needs access to macOS resource counters. Every FFmpeg call has a three-minute subprocess timeout. Use a fresh output directory to preserve prior runs. This is deliberately a fixture-specific benchmark, not a general CLI implementation of Phase 2.

`comfy_trial.py` runs a single 384×512, 16-frame AnimateDiff experiment using installed models and an existing input whose bytes must match the original. It records the submitted graph, node schemas, server environment, prompt ID, history and memory/swap samples. It refuses a busy queue, caps inference at eight minutes, stops below 512 MiB reported free RAM or above 2 GiB additional swap, and interrupts only its own running prompt. It does not install models, change server settings, or restart ComfyUI.

```sh
python3 benchmarks/phase0/comfy_trial.py
```

The ComfyUI script currently writes to `run-01`, so archive that directory or change the experiment output path before another trial. Interrupted inference is a failed resource gate, not a timed successful render or proof that all local video models are infeasible.

Review [the results](RESULTS.md), [the 15-second baseline](run-01/baseline-15s.mp4), [the contact sheet](run-01/contact-sheet.jpg), and [raw timings](run-01/metrics.json). Actual output quality remains subject to user review. One blouse is not sufficient to establish printed-product/logo/lace quality or production reliability.

Cloud candidates are untested in this run: no OpenAI/Gemini API credentials are configured, and this experiment makes no cloud calls. LTX model weights are absent. No music was supplied; the comparison is silent. Source hands, props, decorative symbols and lighting are retained rather than silently replaced with generated content.
