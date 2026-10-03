"""Phase 3B, step B: build and review the CatVTON agnostic mask.

Execution boundary matches checkpoint A exactly: this is a thin Python
runner using only the standard library plus Pillow (a plain image library,
not an ML dependency) - it never imports numpy, torch, ComfyUI's own
node.py, or GroundingDINO/SAM2 directly. GroundingDINO detection and SAM2
segmentation run INSIDE the already-running ComfyUI process, reached only
through ComfyUI's ordinary HTTP API (submit graph -> poll /history ->
download the resulting PNG via /view), the same way every other trial
script in this project talks to ComfyUI.

Steps:
  1. Copy the person image into ComfyUI's input/ directory (LoadImage
     convention - same as every other script in this project).
  2. Submit a graph: LoadImage -> GroundingDinoModelLoader + SAM2ModelLoader
     -> GroundingDinoSAM2Segment -> MaskToImage -> SaveImage. Poll ComfyUI's
     HTTP history API on a plain timer (no LLM/model loop), with the same
     conservative swap/RAM resource-stop as every other trial script here.
  3. Download the resulting raw-mask PNG (real bytes over HTTP, no parsing
     on this side).
  4. Everything from here on is Pillow only, in this process: open the raw
     mask, find its bounding box (Image.getbbox()), expand it via
     comfy_mask_lib.expand_box_for_vton (pure arithmetic, unit tested
     separately), draw the filled rectangle, composite a translucent
     preflight overlay onto the person image, and compute coverage from
     Image.histogram() counts.

Persists FIVE artifacts under benchmarks/phase3b/comfy-run-01/mask/:
  1. person-image.png            - copy of the input person image
  2. sam2-segmentation-mask.png  - the raw (tight) SAM2 mask, rendered by
                                    ComfyUI itself
  3. catvton-agnostic-mask.png   - the final, expanded mask actually fed to
                                    CatVTON
  4. mask-preflight-overlay.png  - the agnostic mask blended translucently
                                    over the person image, for a fast
                                    "does this look right" visual check
  5. mask-summary.json           - coverage stats, the expanded box, timing,
                                    and the resource-monitoring samples

A standalone "GroundingDINO detection boxes" artifact was dropped: the
installed GroundingDinoSAM2Segment node only returns the final (IMAGE, MASK)
pair, with no way to retrieve the intermediate detection boxes through the
graph API. The bounding box used for mask expansion is derived from the
returned mask itself (Image.getbbox()), not from GroundingDINO's box.

Usage (run manually - this performs real GroundingDINO+SAM2 inference,
inside ComfyUI, not in this process):
    python3 benchmarks/phase3b/comfy_mask_trial.py <path/to/person_image.png>
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from PIL import Image, ImageDraw, ImageFilter

import comfy_mask_graph_lib as graph_lib
import comfy_mask_lib as lib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "benchmarks/phase3b/comfy-run-01/mask"
BASE = "http://127.0.0.1:8188/"
COMFYUI_INPUT_DIR = pathlib.Path("/Users/anvh/Documents/comfy/ComfyUI/input")

DETECTION_PROMPT = "shirt, t-shirt, blouse, top, upper body clothing"
DETECTION_THRESHOLD = 0.3

MASK_BINARY_THRESHOLD = 128  # 0-255; ComfyUI's MaskToImage output is expected near-binary already
DILATE_KERNEL_SIZE = 9  # odd, pixels - controlled morphological expansion to close small holes/noise
WAIST_SAMPLE_BAND_PX = 20  # how many rows just above garment_core_bottom to sample for the hem's taper width

TIMEOUT_SECONDS = 180  # detection+segmentation, not diffusion - should be fast
POLL_INTERVAL_SECONDS = 3
MAX_SWAP_GROWTH_MIB = 2048
MIN_FREE_RAM_BYTES = 512 * 1024 ** 2


def api(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(BASE + path, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2))


def read_swap_text():
    return subprocess.run(["sysctl", "vm.swapusage"], capture_output=True, text=True).stdout.strip()


def parse_swap_mib(text):
    match = re.search(r"used = ([\d.]+)M", text)
    return float(match.group(1)) if match else None


def run_mask_segmentation_graph(person_input_filename, run_id):
    """Submit the ComfyUI graph, poll, and return the path of the downloaded
    raw-mask PNG. All GroundingDINO/SAM2 work happens inside ComfyUI.
    """
    queue = api("queue")
    if queue["queue_running"] or queue["queue_pending"]:
        raise SystemExit("ComfyUI is busy; trial not submitted.")

    info = api("object_info")
    for required_node in [
        "GroundingDinoModelLoader (segment anything2)",
        "SAM2ModelLoader (segment anything2)",
        "GroundingDinoSAM2Segment (segment anything2)",
    ]:
        if required_node not in info:
            raise SystemExit(f"'{required_node}' not found in ComfyUI's object_info; is comfyui-sam2 loaded?")

    filename_prefix = f"phase3b-mask-raw-{run_id}"
    graph = graph_lib.build_graph(
        person_image_filename=person_input_filename,
        detection_prompt=DETECTION_PROMPT,
        filename_prefix=filename_prefix,
        threshold=DETECTION_THRESHOLD,
    )
    write_json(OUT / "graph.json", graph)
    write_json(OUT / "environment.json", api("system_stats"))
    write_json(OUT / "node-schemas.json", {n["class_type"]: info[n["class_type"]] for n in graph.values()})

    started = time.monotonic()
    initial_swap = parse_swap_mib(read_swap_text())
    result = {
        "phase": "3B-mask",
        "profile": f"GroundingDINO+SAM2 segmentation, prompt='{DETECTION_PROMPT}', threshold={DETECTION_THRESHOLD}",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timeoutSeconds": TIMEOUT_SECONDS,
        "samples": [],
    }
    prompt_id = None
    raw_mask_path = None
    try:
        submitted = api("prompt", {"prompt": graph, "client_id": "phase3b-mask-" + uuid.uuid4().hex})
        write_json(OUT / "submission.json", submitted)
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
            write_json(OUT / "metrics.json", result)
            print(f"{elapsed:.0f}s free={stats['system']['ram_free'] / 1024 ** 3:.2f}GiB", flush=True)

            if history:
                write_json(OUT / "history.json", history)
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
                    raw_mask_path = OUT / "sam2-segmentation-mask.png"
                    raw_mask_path.write_bytes(image_bytes)
                    result["status"] = "completed"
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
            raise TimeoutError(f"{TIMEOUT_SECONDS}-second budget exhausted")
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
        write_json(OUT / "metrics.json", result)
        print(json.dumps({k: v for k, v in result.items() if k != "samples"}, indent=2), flush=True)

    if raw_mask_path is None:
        raise SystemExit("Mask segmentation did not complete; see metrics.json/history.json for details.")
    return raw_mask_path


def _row_coverage_profile(mask_img):
    """One coverage fraction (0..1) per row, via a box-filtered 1px-wide
    resize - PIL's BOX resampling averages exactly within each output
    pixel's source region, so this is an exact per-row mean without a
    manual pixel loop. No numpy.
    """
    width, height = mask_img.size
    column = mask_img.resize((1, height), Image.Resampling.BOX)
    return [v / 255.0 for v in column.getdata()]


def build_agnostic_mask_artifacts(person_image_path, raw_mask_path):
    """Pillow-only post-processing, no numpy, no ML models - everything
    downstream of the raw mask PNG already returned by ComfyUI:

      1. lightly dilate the raw mask (closes small segmentation holes/noise)
      2. find its bounding box + a per-row coverage profile
      3. find the garment's real core bottom (the gap-scan in comfy_mask_lib,
         which discards contamination like the rejected run's skirt)
      4. clear the raw mask below that line and above the absolute
         head-safety floor - this is the "core", anchored to the real
         segmentation, not a fabricated shape
      5. union in three small, independently-clamped bands (collar,
         sleeve, hem) computed by comfy_mask_lib - never one giant rectangle
    """
    person_image = Image.open(person_image_path).convert("RGB")
    person_image.save(OUT / "person-image.png")

    raw_mask_gray = Image.open(raw_mask_path).convert("L")
    # ComfyUI's MaskToImage output should already be near-binary, but
    # threshold explicitly so getbbox()/dilation aren't thrown off by faint
    # compositing artifacts at the mask edge.
    raw_mask_binary = raw_mask_gray.point(lambda p: 255 if p >= MASK_BINARY_THRESHOLD else 0)
    width, height = raw_mask_binary.size

    bbox = raw_mask_binary.getbbox()
    if bbox is None:
        raise SystemExit(
            f"SAM2 mask at {raw_mask_path} is entirely empty (nothing detected for "
            f"prompt '{DETECTION_PROMPT}'). Lower DETECTION_THRESHOLD or check the person "
            "image actually shows the upper-body clothing region clearly."
        )
    # PIL bbox is (left, upper, right, lower) = (x0, y0, x1, y1).
    x0, y0, x1, y1 = bbox
    neck_y = y0
    torso_width = x1 - x0

    # Step 2+3: find where the garment really ends, from the RAW (undilated)
    # mask's own row-coverage structure - this is what discards
    # contamination like the rejected run's skirt, instead of trusting a
    # fixed ratio of box size. Deliberately computed BEFORE dilation:
    # dilating first smears coverage from the solid rows above/below a real
    # gap into the gap itself, which very nearly closed the actual waist
    # gap in this garment (min coverage during the gap rose from 0% to 3.5%
    # after a 9px dilation - almost erasing the exact signal this step
    # depends on).
    row_coverage = _row_coverage_profile(raw_mask_binary)
    garment_core_bottom = lib.compute_garment_core_bottom(
        neck_y, torso_width, raw_bottom_y=y1, image_height=height, row_coverage=row_coverage
    )

    # Step 1: controlled morphological dilation (a real, bounded expansion
    # of the existing silhouette - not a rectangle) to close small holes and
    # smooth noisy edges, applied only now that the gap has already been
    # located on the undilated ground truth.
    dilated_mask = raw_mask_binary.filter(ImageFilter.MaxFilter(DILATE_KERNEL_SIZE))

    # Step 4: the "core" is the dilated raw silhouette, clipped to rows
    # between the two absolute safety clamps and the discovered garment
    # bottom - never widened into a rectangle at this stage.
    head_floor = lib.head_safety_floor_y(height)
    hip_ceiling = lib.hip_safety_ceiling_y(height)
    core_mask = dilated_mask.copy()
    core_draw = ImageDraw.Draw(core_mask)
    if head_floor > 0:
        core_draw.rectangle((0, 0, width, head_floor), fill=0)
    if garment_core_bottom < height:
        core_draw.rectangle((0, garment_core_bottom, width, height), fill=0)

    # Measure the mask's own local (waist-area) width just above
    # garment_core_bottom, on the RAW (undilated) mask so the taper reflects
    # the real silhouette, not the dilation's rounding. This is what lets
    # the hem band taper to the actual torso width instead of remaining as
    # wide as the shoulders - see hem_band_box's docstring for why that
    # mattered.
    waist_strip_top = max(neck_y, garment_core_bottom - WAIST_SAMPLE_BAND_PX)
    waist_strip = raw_mask_binary.crop((0, waist_strip_top, width, garment_core_bottom))
    waist_bbox = waist_strip.getbbox()
    local_x0, local_x1 = (waist_bbox[0], waist_bbox[2]) if waist_bbox else (None, None)
    taper_x0, taper_x1 = lib.resolve_hem_taper_extent(x0, x1, local_x0, local_x1)

    # Step 5: union in the three small, independently-clamped bands.
    collar_y0, collar_y1, collar_x0, collar_x1 = lib.collar_band_box(neck_y, x0, x1, (height, width))
    sleeve_y0, sleeve_y1, sleeve_x0, sleeve_x1 = lib.sleeve_band_box(
        neck_y, garment_core_bottom, x0, x1, (height, width)
    )
    hem_y0, hem_y1, hem_x0, hem_x1 = lib.hem_band_box(
        garment_core_bottom, x0, x1, taper_x0, taper_x1, (height, width)
    )

    agnostic_mask = core_mask.copy()
    agnostic_draw = ImageDraw.Draw(agnostic_mask)
    agnostic_draw.rectangle((collar_x0, collar_y0, collar_x1, collar_y1), fill=255)
    agnostic_draw.rectangle((sleeve_x0, sleeve_y0, sleeve_x1, sleeve_y1), fill=255)
    # C4: loose-blouse continuation.
    # Wider where it connects to the existing shirt,
    # then gently taper toward the upper hip.
    hem_top_extra = int(round(torso_width * 0.08))

    hem_top_x0 = max(0, hem_x0 - hem_top_extra)
    hem_top_x1 = min(width, hem_x1 + hem_top_extra)

    agnostic_draw.polygon(
        [
            (hem_top_x0, hem_y0),
            (hem_top_x1, hem_y0),
            (hem_x1, hem_y1),
            (hem_x0, hem_y1),
        ],
        fill=255,
    )
    # Belt-and-suspenders: re-assert the absolute safety clamps on the final
    # mask, independent of whether every band individually respected them.
    if head_floor > 0:
        agnostic_draw.rectangle((0, 0, width, head_floor), fill=0)
    if hip_ceiling < height:
        agnostic_draw.rectangle((0, hip_ceiling, width, height), fill=0)
    agnostic_mask.save(OUT / "catvton-agnostic-mask.png")

    overlay_color = (255, 0, 0)
    overlay_alpha = 0.45
    overlay_layer = Image.new("RGBA", person_image.size, (0, 0, 0, 0))
    colored_alpha_mask = agnostic_mask.point(lambda p: int(overlay_alpha * 255) if p >= 128 else 0)
    overlay_layer.paste(Image.new("RGBA", person_image.size, (*overlay_color, 255)), (0, 0), colored_alpha_mask)
    preflight_overlay = Image.alpha_composite(person_image.convert("RGBA"), overlay_layer)
    preflight_overlay.convert("RGB").save(OUT / "mask-preflight-overlay.png")

    def white_count(mask_img):
        histogram = mask_img.histogram()  # 256 buckets for "L" mode
        return sum(histogram[128:])

    total_pixels = width * height
    raw_coverage = lib.mask_coverage_fraction(white_count(raw_mask_binary), total_pixels)
    agnostic_coverage = lib.mask_coverage_fraction(white_count(agnostic_mask), total_pixels)

    summary = {
        "personImage": str(person_image_path),
        "rawMaskImage": str(raw_mask_path),
        "detectionPrompt": DETECTION_PROMPT,
        "detectionThreshold": DETECTION_THRESHOLD,
        "imageSize": {"width": width, "height": height},
        "rawMaskBboxXYXY": list(bbox),
        "dilateKernelSize": DILATE_KERNEL_SIZE,
        "neckY": neck_y,
        "torsoWidth": torso_width,
        "garmentCoreBottom": garment_core_bottom,
        "headSafetyFloorY": head_floor,
        "hipSafetyCeilingY": hip_ceiling,
        "waistTaper": {
            "sampledStripYRange": [waist_strip_top, garment_core_bottom],
            "measuredLocalX": [local_x0, local_x1],
            "resolvedTaperX": [taper_x0, taper_x1],
        },
        "collarBandXYXY": [collar_x0, collar_y0, collar_x1, collar_y1],
        "sleeveBandXYXY": [sleeve_x0, sleeve_y0, sleeve_x1, sleeve_y1],
        "hemBandXYXY": [hem_x0, hem_y0, hem_x1, hem_y1],
        "rawMaskCoverage": raw_coverage,
        "agnosticMaskCoverage": agnostic_coverage,
    }
    write_json(OUT / "mask-summary.json", summary)
    return summary


def main():
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <path/to/person_image.png>")
    person_path = pathlib.Path(sys.argv[1])
    if not person_path.is_file():
        raise SystemExit(f"person image not found: {person_path}")

    OUT.mkdir(parents=True, exist_ok=True)

    run_id = uuid.uuid4().hex[:8]
    comfyui_input_filename = f"phase3b-mask-input-{run_id}{person_path.suffix}"
    COMFYUI_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy(person_path, COMFYUI_INPUT_DIR / comfyui_input_filename)

    raw_mask_path = run_mask_segmentation_graph(comfyui_input_filename, run_id)
    summary = build_agnostic_mask_artifacts(person_path, raw_mask_path)

    print(f"\nDone. Review before proceeding: {OUT / 'mask-preflight-overlay.png'}", flush=True)
    print(f"Agnostic mask coverage: {summary['agnosticMaskCoverage']:.1%} of the image.", flush=True)


if __name__ == "__main__":
    main()
