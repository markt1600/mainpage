#!/usr/bin/env python3
"""Cache only published At Home media; leave browser credentials untouched."""
import hashlib, json, os, pathlib, shutil, subprocess, urllib.request, urllib.parse

ROOT = pathlib.Path.home() / '.config/marktan-birthday-device'
CACHE = ROOT / 'memories'
LIMIT = 12 * 1024**3
RESERVE = 4 * 1024**3

def playable_copy(path):
    if path.suffix not in ('.mp4', '.webm', '.mov'):
        return path
    out = path.with_name(path.stem + '.pi.mp4')
    if out.exists():
        return out
    probe = subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,pix_fmt,color_transfer','-of','json',str(path)],capture_output=True,text=True,check=True)
    video = json.loads(probe.stdout)['streams'][0]
    # Convert phone codecs and oversized video; preserve aspect ratio and rotation.
    if video['codec_name'] == 'h264' and video.get('pix_fmt') == 'yuv420p' and video.get('width',0) <= 1280 and video.get('height',0) <= 1280:
        return path
    if shutil.disk_usage(CACHE).free < RESERVE + 512*1024**2:
        return path
    filters = 'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2'
    if video.get('color_transfer') in ('arib-std-b67','smpte2084'):
        filters += ',zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'
    filters += ',fps=30,format=yuv420p'
    tmp = out.with_suffix('.part.mp4')
    print('Preparing Pi-compatible video ' + path.name[:12],flush=True)
    try:
        subprocess.run(['ffmpeg','-nostdin','-v','error','-y','-threads','2','-i',str(path),'-map','0:v:0','-map','0:a:0?','-vf',filters,'-c:v','libx264','-threads','2','-preset','veryfast','-crf','23','-profile:v','main','-c:a','aac','-b:a','128k','-movflags','+faststart',str(tmp)],check=True,timeout=900)
        tmp.replace(out)
        return out
    except Exception:
        tmp.unlink(missing_ok=True)
        print('Video conversion deferred',flush=True)
        return path

def atomic(path, data):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data), encoding='utf-8')
    tmp.chmod(0o600)
    tmp.replace(path)

def allowed(url):
    u = urllib.parse.urlsplit(url)
    return u.scheme == 'https' and u.netloc == 'athome.marktan.ai' and u.path == '/api/memories' and urllib.parse.parse_qs(u.query).get('action') == ['media']

def sync():
    os.umask(0o077)
    CACHE.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen('https://pi.marktan.ai/api/display-memories', timeout=60) as response:
        feed = json.load(response)
    if not isinstance(feed.get('memories'), list):
        raise ValueError('Invalid published feed; retaining previous cache')
    urls = set()
    for memory in feed['memories']:
        urls.update(a['src'] for a in memory['media'])
        if memory.get('soundtrack'):
            urls.add(memory['soundtrack'])
    if not all(allowed(url) for url in urls):
        raise ValueError('Unexpected media origin')
    def filename(url):
        asset = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('asset', [''])[0]
        ext = pathlib.PurePosixPath(asset).suffix.lower()
        if ext not in ('.jpg','.jpeg','.png','.webp','.mp4','.webm','.mov','.mp3','.m4a','.wav','.ogg','.aac','.flac'):
            ext = '.bin'
        return hashlib.sha256(url.encode()).hexdigest() + ext
    wanted = {filename(url) for url in urls}
    wanted.update(pathlib.Path(name).stem + '.pi.mp4' for name in list(wanted) if pathlib.Path(name).suffix in ('.mp4','.mov','.webm'))
    for path in CACHE.iterdir():
        if path.is_file() and path.name not in wanted:
            path.unlink()
    used = sum(p.stat().st_size for p in CACHE.iterdir() if p.is_file())
    mappings = []
    failed = 0
    for n, url in enumerate(sorted(urls), 1):
        target = CACHE / filename(url)
        if not target.exists():
            tmp = target.with_suffix(target.suffix + '.part')
            try:
                size = 0
                with urllib.request.urlopen(url, timeout=90) as response, tmp.open('wb') as output:
                    if response.status != 200 or not response.headers.get('Content-Type','').startswith(('image/','video/','audio/')):
                        raise ValueError('Unexpected media response')
                    while chunk := response.read(1024*1024):
                        size += len(chunk)
                        if used + size > LIMIT or shutil.disk_usage(CACHE).free < RESERVE:
                            raise OSError('Cache storage limit reached')
                        output.write(chunk)
                    expected = response.headers.get('Content-Length')
                    if not size or (expected and size != int(expected)):
                        raise ValueError('Incomplete media download')
                tmp.replace(target)
                used += size
                print(f'Downloaded {n}/{len(urls)} ({size // 1024} KiB)', flush=True)
            except Exception as exc:
                tmp.unlink(missing_ok=True)
                failed += 1
                print(f'Media {n} deferred: {type(exc).__name__}', flush=True)
                continue
        try:
            playable = playable_copy(target)
        except Exception:
            playable = target
        mappings.append({'url': url, 'path': '/memories/' + playable.name})
    # Only completed files become redirects. Missing assets retain online playback.
    atomic(ROOT / 'memory-feed.json', feed)
    atomic(ROOT / 'memory-index.json', mappings)
    print(f'Cache ready: {len(mappings)}/{len(urls)} assets, {used / 1024**2:.1f} MiB, {failed} deferred', flush=True)

if __name__ == '__main__':
    sync()
