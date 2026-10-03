"""Pure, network-free logic for the Phase 3 single-keyframe ComfyUI trial.

Kept separate from comfy_still_trial.py (which does the actual HTTP polling
and file I/O against a running ComfyUI instance) so the graph-building and
parsing logic can be unit tested without ever contacting ComfyUI or spending
an inference run. See comfy_still_lib_test.py.
"""
import hashlib
import re

POSITIVE_PROMPT = (
    "a young woman wearing a pale periwinkle short-sleeve babydoll blouse, "
    "oversized double-layer rounded Peter Pan collar with ruffle trim at the yoke seam, "
    "three flower-shaped buttons and vertical pintuck pleats down the center front, "
    "short puffed sleeves with elastic-gathered ruffle cuffs, loose relaxed silhouette, "
    "matte woven cotton fabric with soft drape, no print or logo, "
    "standing indoors near a window with soft natural light, waist-up vertical portrait, "
    "DSLR product marketing photograph, sharp focus on garment, clean neutral background"
)

NEGATIVE_PROMPT = (
    "extra or missing buttons, wrong collar shape, single-layer collar, fitted or tailored cut, "
    "printed pattern, embroidery, logo, glossy satin or silk sheen, "
    "deformed hands, extra fingers, distorted face, cropped garment, "
    "blurry, lowres, watermark, text, oversaturated colors, changed garment color"
)


def node(class_type, **inputs):
    """Build one ComfyUI API-graph node entry."""
    return {"class_type": class_type, "inputs": inputs}


def build_graph(
    *,
    checkpoint_name,
    reference_image_filename,
    seed,
    filename_prefix,
    width=576,
    height=864,
    steps=30,
    cfg=6.5,
    ipadapter_weight=0.85,
):
    """Build the 10-node still-keyframe API graph.

    Checkpoint (SD1.5) -> IPAdapter (garment reference, txt2img conditioning)
    -> CLIP positive/negative -> EmptyLatentImage -> KSampler (denoise=1.0,
    full txt2img, no img2img/video motion involved) -> VAEDecode -> SaveImage.

    Every model/file name is a required argument, never hardcoded here -
    the caller resolves them against what's actually installed.
    """
    if not (0.0 < ipadapter_weight <= 5.0):
        raise ValueError(f"ipadapter_weight out of ComfyUI's accepted range: {ipadapter_weight}")
    if steps < 1:
        raise ValueError(f"steps must be positive: {steps}")

    return {
        "1": node("CheckpointLoaderSimple", ckpt_name=checkpoint_name),
        "2": node("LoadImage", image=reference_image_filename),
        "3": node("IPAdapterUnifiedLoader", model=["1", 0], preset="PLUS (high strength)"),
        "4": node(
            "IPAdapterAdvanced",
            model=["3", 0],
            ipadapter=["3", 1],
            image=["2", 0],
            weight=ipadapter_weight,
            weight_type="linear",
            combine_embeds="concat",
            start_at=0.0,
            end_at=1.0,
            embeds_scaling="V only",
        ),
        "5": node("CLIPTextEncode", clip=["1", 1], text=POSITIVE_PROMPT),
        "6": node("CLIPTextEncode", clip=["1", 1], text=NEGATIVE_PROMPT),
        "7": node("EmptyLatentImage", width=width, height=height, batch_size=1),
        "8": node(
            "KSampler",
            model=["4", 0],
            positive=["5", 0],
            negative=["6", 0],
            latent_image=["7", 0],
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name="dpmpp_2m",
            scheduler="karras",
            denoise=1.0,
        ),
        "9": node("VAEDecode", samples=["8", 0], vae=["1", 2]),
        "10": node("SaveImage", images=["9", 0], filename_prefix=filename_prefix),
    }


def parse_swap_mib(sysctl_vm_swapusage_output):
    """Extract the 'used' MiB figure from `sysctl vm.swapusage` output.

    Example input: "vm.swapusage: total = 2048.00M  used = 512.25M  free = ..."
    Returns None if the pattern isn't found (e.g. unexpected locale/format),
    never raises - callers treat a missing swap reading as "unknown", not fatal.
    """
    match = re.search(r"used = ([\d.]+)M", sysctl_vm_swapusage_output)
    return float(match.group(1)) if match else None


def sha256_of_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_reference_matches(source_path, installed_path):
    """True only if both files exist and are byte-identical by hash.

    Guards against silently submitting a workflow against a stale/different
    file that happens to share a filename in ComfyUI's input/ directory.
    """
    if not source_path.is_file() or not installed_path.is_file():
        return False
    return sha256_of_file(source_path) == sha256_of_file(installed_path)
