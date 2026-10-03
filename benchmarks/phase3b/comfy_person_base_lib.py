"""Pure, network-free graph builder for the Phase 3B neutral person-base
image. No garment reference is involved at all - this is a plain SD1.5
txt2img generation, so none of Phase 3's fidelity problem applies here.
See comfy_person_base_trial.py for the actual runner.
"""

POSITIVE_PROMPT = (
    "full length photograph, entire body visible from head to mid-thigh, wide shot, "
    "standing several feet from the camera, a realistic adult woman standing straight, "
    "front-facing camera, feet shoulder-width apart, "
    "both arms held a few inches out from the sides of the torso with a visible gap between "
    "each arm and the torso, elbows straight, hands relaxed at the sides, "
    "wearing a plain fitted white crew-neck short-sleeve T-shirt, simple round neckline, "
    "sleeves fully covering the shoulders and upper arms and ending above the elbow, "
    "plain cotton fabric with no prints, "
    "hair tied back away from the shoulders, "
    "simple plain neutral background, soft even lighting, "
    "normal realistic human body proportions and anatomy, sharp focus, "
    "plain e-commerce apparel catalog photograph, fashion lookbook full-body shot"
)

# Every failure observed in the rejected run is named here explicitly - do
# not rely on negating a concept in the positive prompt instead (CLIP text
# encoders don't parse negation reliably; "nothing covering the chest" reads
# as the concept "chest" being present, not absent, which is what produced
# the tank top and exposed shoulders in the first place).
NEGATIVE_PROMPT = (
    "tank top, camisole, spaghetti straps, strapless, sleeveless, bare shoulders, "
    "exposed chest, cleavage, bra strap, lingerie, bralette, "
    "choker, neck band, neckband, collar band, arm band, armband, arm cuff, elastic band, "
    "crossed arms, arms against torso, arms touching torso, arms hidden behind back, "
    "jacket, cardigan, scarf, hood, necklace, jewelry, accessories, "
    "long sleeves, sleeves past the elbow, hair covering shoulders or chest, "
    "close-up, headshot, bust shot, portrait crop, cropped at chest, cropped at waist, "
    "side profile, looking away, "
    "extra limbs, deformed hands, extra fingers, distorted anatomy, "
    "cluttered background, busy pattern background, blurry, lowres, watermark, text"
)


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": inputs}


def build_graph(
    *,
    checkpoint_name,
    seed,
    filename_prefix,
    width=576,
    height=1024,
    steps=30,
    cfg=6.5,
):
    """8-node plain SD1.5 txt2img graph: checkpoint -> CLIP pos/neg ->
    EmptyLatentImage -> KSampler (denoise=1.0) -> VAEDecode -> SaveImage.
    No IPAdapter, no ControlNet, no garment reference of any kind.
    """
    if steps < 1:
        raise ValueError(f"steps must be positive: {steps}")

    return {
        "1": node("CheckpointLoaderSimple", ckpt_name=checkpoint_name),
        "2": node("CLIPTextEncode", clip=["1", 1], text=POSITIVE_PROMPT),
        "3": node("CLIPTextEncode", clip=["1", 1], text=NEGATIVE_PROMPT),
        "4": node("EmptyLatentImage", width=width, height=height, batch_size=1),
        "5": node(
            "KSampler",
            model=["1", 0],
            positive=["2", 0],
            negative=["3", 0],
            latent_image=["4", 0],
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name="dpmpp_2m",
            scheduler="karras",
            denoise=1.0,
        ),
        "6": node("VAEDecode", samples=["5", 0], vae=["1", 2]),
        "7": node("SaveImage", images=["6", 0], filename_prefix=filename_prefix),
    }
