"""Pure, network-free graph builder for the single Phase 3B CatVTON trial.

6-node graph: three LoadImage nodes (person / garment / agnostic mask,
produced by comfy_person_base_trial.py and comfy_mask_trial.py) feed
LoadCatVTONPipeline -> CatVTON ("TryOn by CatVTON") -> SaveImage. SaveImage
is required: CatVTON does not set OUTPUT_NODE=True, so without it nothing
would appear in ComfyUI's /history outputs.

Note the CatVTON node's `mask_image` input is typed IMAGE, not MASK - the
mask must be loaded as a plain (white=garment region, black=background)
image via LoadImage, matching what comfy_mask_trial.py already saves.
"""


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": inputs}


def build_graph(
    *,
    person_image_filename,
    garment_image_filename,
    mask_image_filename,
    seed,
    filename_prefix,
    steps=50,
    cfg=2.5,
    mixed_precision="fp16",
    device="mps",
    width=512,
    height=768,
    attn_chunk_size=512,
    sd15_inpaint_path="runwayml/stable-diffusion-inpainting",
    catvton_path="zhengchong/CatVTON",
):
    """steps/cfg default to the upstream node's own defaults (see
    Comfyui-CatVTON/__init__.py's CatVTON.INPUT_TYPES) rather than values
    invented here.

    C2 (256x384, fp16, no chunking) completed without crashing but was
    rejected for fidelity: garment identity, collar, ruffle/pintuck
    structure, and buttons/placket were all lost, with hallucinated
    textural artifacts - 256px is too destructive a downsample for this
    product's detail (see the garment-preprocessing note below).

    C3 recovers resolution via query-chunked attention
    (Comfyui-CatVTON/model/attn_processor.py's
    _chunked_scaled_dot_product_attention) instead of shrinking the image
    further. Root cause recap: CatVTONPipeline concatenates person+garment
    latents along the height axis before the UNet's first (full-resolution)
    self-attention block, and MPS has no fused/flash attention kernel for
    that shape, so F.scaled_dot_product_attention's "math" fallback
    materializes the full (batch, heads, seq_q, seq_k) score matrix -
    O(seq^2) memory. Chunking the QUERY sequence into `attn_chunk_size`-row
    pieces (run against the full, unchunked key/value) bounds that matrix
    to (batch, heads, attn_chunk_size, seq_k) - O(seq) instead of O(seq^2) -
    with mathematically identical output (verified numerically to
    <1e-5 max abs diff against full attention; see test_chunked_attention.py).

    512x768 + fp16 + attn_chunk_size=512 is the selected C3 profile: at the
    dominant stage-0 attention buffer this is ~0.94 GiB peak (vs. the
    crashing 768x1024/fp32/unchunked configuration's 180 GiB, and vs.
    256x384's own ~1.4 GiB despite being a much smaller image - chunking
    is that much more memory-efficient than resolution reduction alone).
    Chosen over 576x768/768x1024 to keep meaningful headroom for model
    weights, other UNet stages, and OS/ComfyUI baseline usage given only
    ~5-7 GiB was free at the start of C2's run - not because a higher
    resolution was calculated to be unsafe outright (768x1024 chunked is
    itself only ~1.9-3.75 GiB peak at that one buffer), but because that
    buffer competing against everything else for the same ~6 GiB of
    headroom left little margin. 512px recovers roughly 2.25x more real
    garment detail than 256px did (the reference photo is downsampled
    2.25x vs. 4.49x - see this module's test file for the exact numbers).
    """
    if steps < 1:
        raise ValueError(f"steps must be positive: {steps}")
    if mixed_precision not in ("fp32", "fp16", "bf16"):
        raise ValueError(f"unknown mixed_precision: {mixed_precision}")
    if device not in ("mps", "cpu", "cuda"):
        raise ValueError(f"unknown device: {device}")
    if width < 64 or width % 64 != 0:
        raise ValueError(f"width must be a positive multiple of 64 (matches the node's INPUT_TYPES step): {width}")
    if height < 64 or height % 64 != 0:
        raise ValueError(f"height must be a positive multiple of 64 (matches the node's INPUT_TYPES step): {height}")
    if attn_chunk_size is not None and attn_chunk_size < 0:
        raise ValueError(f"attn_chunk_size must be >= 0 (0 disables chunking): {attn_chunk_size}")

    return {
        "1": node("LoadImage", image=person_image_filename),
        "2": node("LoadImage", image=garment_image_filename),
        "3": node("LoadImage", image=mask_image_filename),
        "4": node(
            "LoadCatVTONPipeline",
            sd15_inpaint_path=sd15_inpaint_path,
            catvton_path=catvton_path,
            mixed_precision=mixed_precision,
            device=device,
            attn_chunk_size=attn_chunk_size or 0,
        ),
        "5": node(
            "CatVTON",
            pipe=["4", 0],
            target_image=["1", 0],
            refer_image=["2", 0],
            mask_image=["3", 0],
            seed=seed,
            steps=steps,
            cfg=cfg,
            width=width,
            height=height,
        ),
        "6": node("SaveImage", images=["5", 0], filename_prefix=filename_prefix),
    }
