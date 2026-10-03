"""Pure, network-free graph builder for the Phase 3B mask-segmentation step.

Node classes and their input/output schemas below were confirmed against a
live ComfyUI /object_info (2026-09-27) before writing this, not guessed:

  GroundingDinoModelLoader (segment anything2)
    required: {model_name: [choices incl. "GroundingDINO_SwinT_OGC (694MB)"]}
    output:   GROUNDING_DINO_MODEL

  SAM2ModelLoader (segment anything2)
    required: {model_name: [choices incl. "sam2_hiera_tiny"]}
    output:   SAM2_MODEL

  GroundingDinoSAM2Segment (segment anything2)
    required: {sam_model: SAM2_MODEL, grounding_dino_model: GROUNDING_DINO_MODEL,
               image: IMAGE, prompt: STRING, threshold: FLOAT}
    output:   IMAGE, MASK
    (no separate detection-box output exists on this node - the combined
    detect+segment call only returns the final matted image and mask, so
    a standalone "GroundingDINO detection" artifact isn't obtainable this
    way; the bounding box used for mask expansion is instead derived from
    the returned MASK itself, in the harness runner, via Pillow's
    Image.getbbox() - see comfy_mask_trial.py.)

  MaskToImage (ComfyUI core)
    required: {mask: MASK}
    output:   IMAGE

  SaveImage (ComfyUI core)
    required: {images: IMAGE, filename_prefix: STRING}
    output_node: True
"""


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": inputs}


def build_graph(
    *,
    person_image_filename,
    detection_prompt,
    filename_prefix,
    threshold=0.3,
    sam_model_name="sam2_hiera_tiny",
    grounding_dino_model_name="GroundingDINO_SwinT_OGC (694MB)",
):
    """6-node graph: LoadImage -> (GroundingDinoModelLoader + SAM2ModelLoader)
    -> GroundingDinoSAM2Segment -> MaskToImage -> SaveImage.

    GroundingDINO detection and SAM2 segmentation both execute inside the
    already-running ComfyUI process (which already has torch/SAM2/
    GroundingDINO installed) - nothing ML-related is imported by the caller
    of this function.
    """
    if not (0.0 <= threshold <= 1.0):
        raise ValueError(f"threshold out of range: {threshold}")
    if not detection_prompt.strip():
        raise ValueError("detection_prompt must not be empty")

    return {
        "1": node("LoadImage", image=person_image_filename),
        "2": node("GroundingDinoModelLoader (segment anything2)", model_name=grounding_dino_model_name),
        "3": node("SAM2ModelLoader (segment anything2)", model_name=sam_model_name),
        "4": node(
            "GroundingDinoSAM2Segment (segment anything2)",
            sam_model=["3", 0],
            grounding_dino_model=["2", 0],
            image=["1", 0],
            prompt=detection_prompt,
            threshold=threshold,
        ),
        "5": node("MaskToImage", mask=["4", 1]),
        "6": node("SaveImage", images=["5", 0], filename_prefix=filename_prefix),
    }
