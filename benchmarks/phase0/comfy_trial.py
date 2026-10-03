"""One bounded local Phase 0 trial. File artifacts only; no production integration."""
import hashlib, json, pathlib, re, subprocess, time, urllib.request, urllib.parse, uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'benchmarks/phase0/run-01'
BASE = 'http://127.0.0.1:8188/'
OUT.mkdir(parents=True, exist_ok=True)
def api(path, data=None):
    req = urllib.request.Request(BASE + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)
def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2))
def node(kind, **inputs):
    return {'class_type': kind, 'inputs': inputs}
def swap_mib(text):
    match = re.search(r'used = ([\d.]+)M', text)
    return float(match[1]) if match else None

queue = api('queue')
if queue['queue_running'] or queue['queue_pending']:
    raise SystemExit('ComfyUI is busy; trial not submitted.')
source = ROOT / '.workdir/quick-video/scratchpad/comfy-affiliate-v1/assets/ref/overview_3.png'
installed = pathlib.Path('/Users/anvh/Documents/comfy/ComfyUI/input/overview_3.png')
if hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(installed.read_bytes()).digest():
    raise SystemExit('Existing ComfyUI image differs from benchmark source; refusing ambiguous input.')
graph = {
    '1': node('CheckpointLoaderSimple', ckpt_name='realisticVisionV60B1.safetensors'),
    '2': node('LoadImage', image='overview_3.png'),
    '3': node('ImageScale', image=['2',0], upscale_method='lanczos', width=384, height=512, crop='disabled'),
    '4': node('RepeatImageBatch', image=['3',0], amount=16),
    '5': node('VAEEncode', pixels=['4',0], vae=['1',2]),
    '6': node('ADE_AnimateDiffLoaderGen1', model=['1',0], model_name='mm_sd_v15_v2.ckpt', beta_schedule='autoselect'),
    '7': node('IPAdapterUnifiedLoader', model=['6',0], preset='PLUS (high strength)'),
    '8': node('IPAdapterAdvanced', model=['7',0], ipadapter=['7',1], image=['3',0], weight=0.6, weight_type='linear', combine_embeds='concat', start_at=0.0, end_at=1.0, embeds_scaling='V only'),
    '9': node('CLIPTextEncode', clip=['1',1], text='The same pale blue blouse, unchanged rounded collar, flower buttons, ruffled trim, original product photograph, very subtle natural fabric motion, fixed camera, consistent color and garment details'),
    '10': node('CLIPTextEncode', clip=['1',1], text='redesigned garment, missing buttons, new pattern, changing color, flicker, morphing, hands, person, distorted collar, extra decorations'),
    '11': node('KSampler', model=['8',0], positive=['9',0], negative=['10',0], latent_image=['5',0], seed=555, steps=16, cfg=6.0, sampler_name='dpmpp_2m', scheduler='karras', denoise=0.35),
    '12': node('VAEDecode', samples=['11',0], vae=['1',2]),
    '13': node('VHS_VideoCombine', images=['12',0], frame_rate=8.0, loop_count=0, filename_prefix='phase0-benchmark-'+uuid.uuid4().hex[:8], format='video/h264-mp4', pix_fmt='yuv420p', crf=19, pingpong=False, save_output=True, save_metadata=True),
}
write('comfy-graph.json', graph)
write('comfy-environment.json', api('system_stats'))
info = api('object_info')
write('comfy-node-schemas.json', {n['class_type']:info[n['class_type']] for n in graph.values()})
started = time.monotonic()
initial_swap = swap_mib(subprocess.run(['sysctl','vm.swapusage'],capture_output=True,text=True).stdout)
result = {'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()), 'profile':'384x512, 16 frames, 8fps, 16 steps, seed555, denoise0.35, AnimateDiff+IPAdapter; no depth', 'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(), 'timeoutSeconds':480, 'samples':[]}
prompt_id = None
try:
    submitted = api('prompt', {'prompt':graph,'client_id':'phase0-'+uuid.uuid4().hex})
    write('comfy-submission.json',submitted)
    if submitted.get('node_errors'): raise RuntimeError(str(submitted['node_errors']))
    prompt_id = submitted['prompt_id'];result['promptId']=prompt_id
    while time.monotonic()-started < 480:
        elapsed = time.monotonic()-started
        history = api('history/'+prompt_id).get(prompt_id)
        stats = api('system_stats')
        swap = subprocess.run(['sysctl','vm.swapusage'],capture_output=True,text=True).stdout.strip()
        result['samples'].append({'elapsedSeconds':elapsed,'ramFreeBytes':stats['system']['ram_free'],'swap':swap})
        write('comfy-metrics.json',result)
        print(f'{elapsed:.0f}s free={stats["system"]["ram_free"]/1024**3:.2f}GiB',flush=True)
        if history:
            write('comfy-history.json',history)
            status=history.get('status',{})
            if status.get('status_str')=='error': raise RuntimeError('ComfyUI execution error; see history')
            if status.get('completed'):
                refs=history.get('outputs',{}).get('13',{}).get('gifs',[])
                if not refs: raise RuntimeError('Declared output node has no video')
                ref=refs[0];params=urllib.parse.urlencode({k:ref[k] for k in ['filename','subfolder','type'] if k in ref})
                with urllib.request.urlopen(BASE+'view?'+params,timeout=20) as response:
                    (OUT/'animatediff-2s.mp4').write_bytes(response.read())
                result['status']='completed';break
        if stats['system']['ram_free'] < 512*1024**2:
            raise RuntimeError('Low-memory stop: reported free memory below 512MiB')
        current_swap = swap_mib(swap)
        if initial_swap is not None and current_swap is not None and current_swap-initial_swap > 2048:
            raise RuntimeError('Resource stop: swap growth exceeds conservative 2GiB trial budget; not an OOM assertion')
        time.sleep(10)
    else: raise TimeoutError('480-second inference budget exhausted')
except Exception as exc:
    result['status']='failed';result['error']=str(exc)
finally:
    if prompt_id and result.get('status')!='completed':
        try:
            q=api('queue')
            if any(entry[1]==prompt_id for entry in q['queue_pending']): api('queue',{'delete':[prompt_id]})
            if any(entry[1]==prompt_id for entry in q['queue_running']): api('interrupt',{})
            # Confirm our own work stopped; never cancel another running prompt.
            for _ in range(12):
                q=api('queue')
                if not any(entry[1]==prompt_id for entry in q['queue_running']+q['queue_pending']): break
                time.sleep(2)
            result['ownPromptStillQueued']=any(entry[1]==prompt_id for entry in q['queue_running']+q['queue_pending'])
        except Exception as exc: result['cancellationError']=str(exc)
    result['elapsedSeconds']=time.monotonic()-started
    write('comfy-metrics.json',result)
    print(json.dumps({k:v for k,v in result.items() if k!='samples'}),flush=True)
