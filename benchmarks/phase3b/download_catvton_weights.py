"""Standalone CatVTON weight download - direct huggingface_hub calls, no
ComfyUI graph execution and no model loading/inference.

Downloads exactly what CatVTONPipeline.__init__ (Comfyui-CatVTON/model/pipeline.py)
will look for, pre-populating the local HF cache so the real timed benchmark
run resolves everything from disk with zero network calls:

  - runwayml/stable-diffusion-inpainting: unet/ + scheduler/ only (this
    pipeline never loads that repo's text_encoder/tokenizer - it runs with
    encoder_hidden_states=None, see pipeline.py's __call__).
  - stabilityai/sd-vae-ft-mse: the vae, safetensors only.
  - zhengchong/CatVTON: full repo (1.33 GiB) - the node's own
    auto_attn_ckpt_load() calls snapshot_download() with no filter, so a
    partial local cache wouldn't save a real download later anyway; the
    unneeded SCHP/DensePose subfolders inside it are small enough (~0.8 GiB)
    not to bother filtering out.

Run manually: python3 benchmarks/phase3b/download_catvton_weights.py
"""
from huggingface_hub import snapshot_download

DOWNLOADS = [
    dict(
        repo_id="runwayml/stable-diffusion-inpainting",
        allow_patterns=["unet/config.json", "unet/diffusion_pytorch_model.bin", "scheduler/*"],
    ),
    dict(
        repo_id="stabilityai/sd-vae-ft-mse",
        allow_patterns=["config.json", "diffusion_pytorch_model.safetensors"],
    ),
    dict(repo_id="zhengchong/CatVTON"),
]


def main():
    for spec in DOWNLOADS:
        print(f"=== downloading {spec['repo_id']} ===", flush=True)
        path = snapshot_download(**spec)
        print(f"-> cached at {path}", flush=True)


if __name__ == "__main__":
    main()
