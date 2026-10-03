1.
python3 benchmarks/phase3b/comfy_person_base_trial.py

2.
python3 benchmarks/phase3b/comfy_mask_trial.py \
  benchmarks/phase3b/comfy-run-01/person-base/phase3b-person-base-41d95fa8_00001_.png

3.
cd /Users/anvh/go/src/github.com/anvh2/harness-engineering

cp benchmarks/phase3b/comfy-run-01/person-base/phase3b-person-base-41d95fa8_00001_.png \
  /Users/anvh/Documents/comfy/ComfyUI/input/phase3b-person.png

cp benchmarks/phase3b/comfy-run-01/mask/catvton-agnostic-mask.png \
  /Users/anvh/Documents/comfy/ComfyUI/input/phase3b-mask.png

ls -lh \
  /Users/anvh/Documents/comfy/ComfyUI/input/phase3b-person.png \
  /Users/anvh/Documents/comfy/ComfyUI/input/phase3b-mask.png

python3 benchmarks/phase3b/comfy_catvton_trial.py \
  phase3b-person.png \
  phase3b-mask.png