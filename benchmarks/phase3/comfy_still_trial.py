"""Phase 3, single bounded ComfyUI still-keyframe trial.

Submits exactly ONE marketing-keyframe workflow to a locally running ComfyUI
at http://127.0.0.1:8188, polls its HTTP history API on a plain timed loop
(no LLM/model reasoning in this loop - it is pure HTTP polling), and persists
the prompt id, the submitted graph/config, timing, errors, and memory/swap
samples under benchmarks/phase3/comfy-run-01/. On completion, downloads the
generated image into the same directory.

This is a technical benchmark run, not a production integration: it writes
files only, touches no database/UI/job queue, and does not chain into video
assembly. See comfy_still_lib.py for the pure, unit-tested graph-building and
parsing logic this script orchestrates.

Usage (run manually; this script performs the actual paid/GPU inference):
    python3 benchmarks/phase3/comfy_still_trial.py
"""
import json
import pathlib
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import comfy_still_lib as lib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "benchmarks/phase3/comfy-run-01"
BASE = "http://127.0.0.1:8188/"

REFERENCE_FILENAME = "overview_3.png"
REFERENCE_SOURCE = ROOT / ".workdir/quick-video/scratchpad/comfy-affiliate-v1/assets/ref/overview_3.png"
REFERENCE_INSTALLED = pathlib.Path("/Users/anvh/Documents/comfy/ComfyUI/input") / REFERENCE_FILENAME

CHECKPOINT_NAME = "realisticVisionV60B1.safetensors"
SEED = 20260927
TIMEOUT_SECONDS = 300
POLL_INTERVAL_SECONDS = 5
MAX_SWAP_GROWTH_MIB = 2048  # conservative resource-stop budget, same policy as Phase 0
MIN_FREE_RAM_BYTES = 512 * 1024 ** 2


def api(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        BASE + path, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2))


def read_swap_text():
    return subprocess.run(
        ["sysctl", "vm.swapusage"], capture_output=True, text=True
    ).stdout.strip()


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    queue = api("queue")
    if queue["queue_running"] or queue["queue_pending"]:
        raise SystemExit("ComfyUI is busy; trial not submitted.")

    if not lib.verify_reference_matches(REFERENCE_SOURCE, REFERENCE_INSTALLED):
        raise SystemExit(
            "Reference image mismatch: "
            f"{REFERENCE_SOURCE} does not match the byte content of the file "
            f"already installed at {REFERENCE_INSTALLED}. Refusing an ambiguous input."
        )

    run_id = uuid.uuid4().hex[:8]
    filename_prefix = f"phase3-keyframe-{run_id}"
    graph = lib.build_graph(
        checkpoint_name=CHECKPOINT_NAME,
        reference_image_filename=REFERENCE_FILENAME,
        seed=SEED,
        filename_prefix=filename_prefix,
    )
    write("graph.json", graph)
    write("environment.json", api("system_stats"))
    info = api("object_info")
    write("node-schemas.json", {n["class_type"]: info[n["class_type"]] for n in graph.values()})

    started = time.monotonic()
    initial_swap = lib.parse_swap_mib(read_swap_text())
    result = {
        "phase": 3,
        "profile": "576x864 txt2img, SD1.5 realisticVisionV60B1 + IPAdapter PLUS (garment reference, weight 0.85), "
        "30 steps, cfg 6.5, dpmpp_2m/karras, seed fixed, denoise 1.0 (no img2img/motion)",
        "referenceImageSha256": lib.sha256_of_file(REFERENCE_SOURCE),
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timeoutSeconds": TIMEOUT_SECONDS,
        "samples": [],
    }
    prompt_id = None
    try:
        submitted = api("prompt", {"prompt": graph, "client_id": "phase3-" + uuid.uuid4().hex})
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
                {
                    "elapsedSeconds": elapsed,
                    "ramFreeBytes": stats["system"]["ram_free"],
                    "swap": swap_text,
                }
            )
            write("metrics.json", result)
            print(
                f"{elapsed:.0f}s free={stats['system']['ram_free'] / 1024 ** 3:.2f}GiB",
                flush=True,
            )

            if history:
                write("history.json", history)
                status = history.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError("ComfyUI execution error; see history.json")
                if status.get("completed"):
                    refs = history.get("outputs", {}).get("10", {}).get("images", [])
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
            current_swap = lib.parse_swap_mib(swap_text)
            if (
                initial_swap is not None
                and current_swap is not None
                and current_swap - initial_swap > MAX_SWAP_GROWTH_MIB
            ):
                raise RuntimeError(
                    f"Resource stop: swap growth exceeds conservative {MAX_SWAP_GROWTH_MIB}MiB "
                    "trial budget; not an OOM assertion"
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
                # Confirm our own work stopped; never cancel another running prompt.
                for _ in range(12):
                    q = api("queue")
                    if not any(
                        entry[1] == prompt_id for entry in q["queue_running"] + q["queue_pending"]
                    ):
                        break
                    time.sleep(2)
                result["ownPromptStillQueued"] = any(
                    entry[1] == prompt_id for entry in q["queue_running"] + q["queue_pending"]
                )
            except Exception as exc:  # best-effort cleanup only
                result["cancellationError"] = str(exc)
        result["elapsedSeconds"] = time.monotonic() - started
        write("metrics.json", result)
        print(json.dumps({k: v for k, v in result.items() if k != "samples"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
