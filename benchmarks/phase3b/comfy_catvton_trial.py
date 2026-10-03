"""Phase 3B, step C: exactly ONE bounded CatVTON try-on generation.

Requires (both produced by the two earlier steps, and copied into ComfyUI's
input/ directory so LoadImage can address them by filename):
  - a person-base image  (comfy_person_base_trial.py, step A)
  - a garment reference   (already installed: overview_3.png)
  - a reviewed agnostic mask (comfy_mask_trial.py, step B -
    catvton-agnostic-mask.png)

Same bounded-trial discipline as benchmarks/phase3/comfy_still_trial.py and
comfy_person_base_trial.py: one submission, polls ComfyUI's HTTP history API
on a plain timer (no LLM/model loop), conservative swap/RAM resource-stop,
persists graph/config/timing/errors/memory samples plus the output image
under benchmarks/phase3b/comfy-run-01/catvton/.

This is the one real, comparatively expensive generation in this phase
(50 diffusion steps over a 768x1024 UNet) - deliberately not run by the
agent that wrote this script. Run it manually:
    python3 benchmarks/phase3b/comfy_catvton_trial.py \\
        <person_image_filename_in_comfyui_input> \\
        <mask_image_filename_in_comfyui_input>

Both filenames are looked up inside ComfyUI's own input/ directory (same
convention as LoadImage everywhere else in this project), not as local
paths - copy the files there first if they aren't already.
"""
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import comfy_catvton_lib as lib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "benchmarks/phase3b/comfy-run-01/catvton"
BASE = "http://127.0.0.1:8188/"

GARMENT_IMAGE_FILENAME = "overview_3.png"  # same hash-verified reference used in Phase 0/2/3
SEED = 20260927
STEPS = 50  # upstream default
CFG = 2.5  # upstream default
# C1 (768x1024/fp32/unchunked) crashed: RuntimeError: Invalid buffer size:
# 36.00 GiB in F.scaled_dot_product_attention. C2 (256x384/fp16/unchunked)
# completed but was REJECTED for fidelity - garment identity, collar,
# ruffle/pintuck structure and buttons/placket were all lost.
#
# C3 recovers resolution via query-chunked attention instead of shrinking
# the image further - see comfy_catvton_lib.build_graph's docstring and
# Comfyui-CatVTON/model/attn_processor.py's
# _chunked_scaled_dot_product_attention for the full derivation, and
# benchmarks/phase3b/test_chunked_attention.py for the numerical-equivalence
# proof (9/9 passing, <1e-5 max abs diff vs. unchunked attention). At
# 512x768/fp16/attn_chunk_size=512 the dominant (stage-0) attention buffer
# is an estimated ~0.94 GiB peak, vs. C1's 180 GiB and even C2's own ~1.4
# GiB - chunking bounds that buffer to O(seq) instead of O(seq^2), so a 2x
# larger image is still dramatically cheaper once chunked.
MIXED_PRECISION = "fp16"
DEVICE = "mps"
WIDTH = 512
HEIGHT = 768
ATTN_CHUNK_SIZE = 512
TIMEOUT_SECONDS = 900  # 50-step diffusion over a full SD1.5-sized UNet; generous vs. the still-image trial
POLL_INTERVAL_SECONDS = 10
MAX_SWAP_GROWTH_MIB = 2048
MIN_FREE_RAM_BYTES = 512 * 1024 ** 2


def api(path, data=None, timeout=15):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(BASE + path, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2))


def read_swap_text():
    return subprocess.run(["sysctl", "vm.swapusage"], capture_output=True, text=True).stdout.strip()


def parse_swap_mib(text):
    import re

    match = re.search(r"used = ([\d.]+)M", text)
    return float(match.group(1)) if match else None


def main():
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} <person_image_filename> <mask_image_filename>")
    person_filename, mask_filename = sys.argv[1], sys.argv[2]

    OUT.mkdir(parents=True, exist_ok=True)

    queue = api("queue")
    if queue["queue_running"] or queue["queue_pending"]:
        raise SystemExit("ComfyUI is busy; trial not submitted.")

    info = api("object_info")
    for required_node in ["LoadCatVTONPipeline", "CatVTON"]:
        if required_node not in info:
            raise SystemExit(
                f"'{required_node}' not found in ComfyUI's object_info. "
                "Restart ComfyUI so the newly installed Comfyui-CatVTON custom node loads, "
                "then re-run this script."
            )

    run_id = uuid.uuid4().hex[:8]
    filename_prefix = f"phase3b-catvton-{run_id}"
    graph = lib.build_graph(
        person_image_filename=person_filename,
        garment_image_filename=GARMENT_IMAGE_FILENAME,
        mask_image_filename=mask_filename,
        seed=SEED,
        filename_prefix=filename_prefix,
        steps=STEPS,
        cfg=CFG,
        mixed_precision=MIXED_PRECISION,
        device=DEVICE,
        width=WIDTH,
        height=HEIGHT,
        attn_chunk_size=ATTN_CHUNK_SIZE,
    )
    write("graph.json", graph)
    write("environment.json", api("system_stats"))
    write("node-schemas.json", {n["class_type"]: info[n["class_type"]] for n in graph.values()})

    started = time.monotonic()
    initial_swap = parse_swap_mib(read_swap_text())
    result = {
        "phase": "3B-catvton",
        "profile": f"CatVTON try-on, {WIDTH}x{HEIGHT}, attn_chunk_size={ATTN_CHUNK_SIZE}, "
        f"{STEPS} steps, cfg {CFG}, {MIXED_PRECISION}, device={DEVICE}, "
        f"person={person_filename}, garment={GARMENT_IMAGE_FILENAME}, mask={mask_filename}",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timeoutSeconds": TIMEOUT_SECONDS,
        "samples": [],
    }
    prompt_id = None
    try:
        submitted = api("prompt", {"prompt": graph, "client_id": "phase3b-catvton-" + uuid.uuid4().hex})
        write("submission.json", submitted)
        if submitted.get("node_errors"):
            raise RuntimeError(str(submitted["node_errors"]))
        prompt_id = submitted["prompt_id"]
        result["promptId"] = prompt_id

        while time.monotonic() - started < TIMEOUT_SECONDS:
            elapsed = time.monotonic() - started
            history = api("history/" + prompt_id).get(prompt_id)
            stats = api("system_stats")
            swap_text = read_swap_text()
            result["samples"].append(
                {"elapsedSeconds": elapsed, "ramFreeBytes": stats["system"]["ram_free"], "swap": swap_text}
            )
            write("metrics.json", result)
            print(f"{elapsed:.0f}s free={stats['system']['ram_free'] / 1024 ** 3:.2f}GiB", flush=True)

            if history:
                write("history.json", history)
                status = history.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError("ComfyUI execution error; see history.json")
                if status.get("completed"):
                    refs = history.get("outputs", {}).get("6", {}).get("images", [])
                    if not refs:
                        raise RuntimeError("Declared SaveImage output node has no images")
                    ref = refs[0]
                    params = urllib.parse.urlencode(
                        {k: ref[k] for k in ["filename", "subfolder", "type"] if k in ref}
                    )
                    with urllib.request.urlopen(BASE + "view?" + params, timeout=30) as response:
                        image_bytes = response.read()
                    out_image = OUT / ref["filename"]
                    out_image.write_bytes(image_bytes)
                    result["status"] = "completed"
                    result["outputImage"] = str(out_image)
                    break

            if stats["system"]["ram_free"] < MIN_FREE_RAM_BYTES:
                raise RuntimeError("Low-memory stop: reported free memory below 512MiB")
            current_swap = parse_swap_mib(swap_text)
            if initial_swap is not None and current_swap is not None and current_swap - initial_swap > MAX_SWAP_GROWTH_MIB:
                raise RuntimeError(
                    f"Resource stop: swap growth exceeds conservative {MAX_SWAP_GROWTH_MIB}MiB trial budget"
                )
            time.sleep(POLL_INTERVAL_SECONDS)
        else:
            raise TimeoutError(f"{TIMEOUT_SECONDS}-second inference budget exhausted")
    except (RuntimeError, TimeoutError, urllib.error.URLError) as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
    finally:
        if prompt_id and result.get("status") != "completed":
            try:
                q = api("queue")
                if any(entry[1] == prompt_id for entry in q["queue_pending"]):
                    api("queue", {"delete": [prompt_id]})
                if any(entry[1] == prompt_id for entry in q["queue_running"]):
                    api("interrupt", {})
                for _ in range(12):
                    q = api("queue")
                    if not any(entry[1] == prompt_id for entry in q["queue_running"] + q["queue_pending"]):
                        break
                    time.sleep(2)
                result["ownPromptStillQueued"] = any(
                    entry[1] == prompt_id for entry in q["queue_running"] + q["queue_pending"]
                )
            except Exception as exc:
                result["cancellationError"] = str(exc)
        result["elapsedSeconds"] = time.monotonic() - started
        write("metrics.json", result)
        print(json.dumps({k: v for k, v in result.items() if k != "samples"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
