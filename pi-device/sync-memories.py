#!/usr/bin/env python3
"""Cache only published At Home media; leave browser credentials untouched."""
import hashlib, json, os, pathlib, shutil, urllib.request, urllib.parse

ROOT = pathlib.Path.home() / '.config/marktan-birthday-device'
CACHE = ROOT / 'memories'
LIMIT = 12 * 1024**3
RESERVE = 4 * 1024**3

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
        mappings.append({'url': url, 'path': '/memories/' + target.name})
    # Only completed files become redirects. Missing assets retain online playback.
    atomic(ROOT / 'memory-feed.json', feed)
    atomic(ROOT / 'memory-index.json', mappings)
    print(f'Cache ready: {len(mappings)}/{len(urls)} assets, {used / 1024**2:.1f} MiB, {failed} deferred', flush=True)

if __name__ == '__main__':
    sync()
