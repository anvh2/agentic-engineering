"""Phase 3B, step A: generate the neutral synthetic person-base image.

Plain SD1.5 txt2img, no garment reference, no IPAdapter - this exists only
to produce a person to try the blouse onto, so Phase 3's fidelity problem
does not apply. Same bounded-trial discipline as
benchmarks/phase3/comfy_still_trial.py: one submission, polls ComfyUI's
HTTP history API on a plain timer (no LLM/model loop), conservative
swap/RAM resource-stop, and persists graph/config/timing/errors/memory
samples plus the output image under benchmarks/phase3b/comfy-run-01/person-base/.

Usage (run manually - this performs real GPU inference):
    python3 benchmarks/phase3b/comfy_person_base_trial.py
"""
import json
import pathlib
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import comfy_person_base_lib as lib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "benchmarks/phase3b/comfy-run-01/person-base"
BASE = "http://127.0.0.1:8188/"

CHECKPOINT_NAME = "realisticVisionV60B1.safetensors"
SEED = 20260927
TIMEOUT_SECONDS = 300
POLL_INTERVAL_SECONDS = 5
MAX_SWAP_GROWTH_MIB = 2048
MIN_FREE_RAM_BYTES = 512 * 1024 ** 2


def api(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(BASE + path, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as response:
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
    OUT.mkdir(parents=True, exist_ok=True)

    queue = api("queue")
    if queue["queue_running"] or queue["queue_pending"]:
        raise SystemExit("ComfyUI is busy; trial not submitted.")

    run_id = uuid.uuid4().hex[:8]
    filename_prefix = f"phase3b-person-base-{run_id}"
    graph = lib.build_graph(checkpoint_name=CHECKPOINT_NAME, seed=SEED, filename_prefix=filename_prefix)
    write("graph.json", graph)
    write("environment.json", api("system_stats"))
    info = api("object_info")
    write("node-schemas.json", {n["class_type"]: info[n["class_type"]] for n in graph.values()})

    started = time.monotonic()
    initial_swap = parse_swap_mib(read_swap_text())
    result = {
        "phase": "3B-person-base",
        "profile": "640x896 plain SD1.5 txt2img, realisticVisionV60B1, no garment/IPAdapter, "
        "30 steps, cfg 6.5, dpmpp_2m/karras, seed fixed",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timeoutSeconds": TIMEOUT_SECONDS,
        "samples": [],
    }
    prompt_id = None
    try:
        submitted = api("prompt", {"prompt": graph, "client_id": "phase3b-person-" + uuid.uuid4().hex})
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
                    refs = history.get("outputs", {}).get("7", {}).get("images", [])
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
