"""Loopback-only prose generator; no private calendar or birthday data is used."""
import datetime, json, random, re, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

LOCK = threading.Lock()
HISTORY = []
ANGLES = ['a tiny comic scene', 'a whimsical observation', 'a miniature story with a dry punchline',
          'a gently absurd comparison', 'a curious everyday detail', 'a warm, wry daydream']
OBJECTS = ['an umbrella', 'a lift', 'a sleepy pigeon', 'a coffee cup', 'a queue', 'a houseplant',
           'a sock', 'a bus stop', 'a cloud', 'a shopping bag', 'a fridge', 'a teaspoon']

def get_json(url, data=None, timeout=10):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)

def generate():
    now = datetime.datetime.now(ZoneInfo('Asia/Singapore'))
    context = {'Singapore time': now.strftime('%A %d %B, %H:%M')}
    try:
        data = get_json('https://pi.marktan.ai/api/display')
        context['weather'] = data.get('weather')
        context['weather_updated'] = data.get('fetchedAt')
    except Exception:
        pass
    try:
        data = get_json('https://pi.marktan.ai/api/display-aqi')
        context['air'] = {k:data.get(k) for k in ['value','label','observedAt']}
    except Exception:
        pass
    prompt = ('You write charming miniature fiction for a small screen. Write exactly one short '
              'paragraph of 3 sentences, about 50 words, in natural English. Give an everyday object '
              'an amusing secret life. Build a coherent little scene and end with a gentle, dry joke. '
              'Use plain conversational words, not poetic or gloomy language. No whispering, '
              'forgotten dreams or life lessons. No title or report. /no_think')
    weather = context.get('weather') or {}
    background = f"Singapore, {now.strftime('%A %H:%M')}; {weather.get('condition','weather unknown')}."
    air = context.get('air') or {}
    if air.get('label'): background += ' Air quality: '+str(air['label'])+'.'
    user = f"Write {random.choice(ANGLES)} about {random.choice(OBJECTS)}. Background mood: {background}"
    user += '\nAvoid these recent opening ideas: ' + ' | '.join(t[:100] for t in HISTORY[-5:])
    result = get_json('http://127.0.0.1:8091/v1/chat/completions', {
        'messages':[{'role':'system','content':prompt},
                    {'role':'user','content':'Write a tiny comedy about a houseplant.'},
                    {'role':'assistant','content':'The houseplant has been promoted to head of the windowsill. Its responsibilities include leaning slightly left and judging the curtains. So far it has attended fewer meetings than anyone else in the flat and achieved roughly the same results.'},
                    {'role':'user','content':user}],
        'temperature':0.8, 'top_p':0.9, 'max_tokens':160,
        'chat_template_kwargs':{'enable_thinking':False}}, timeout=100)
    text = result['choices'][0]['message']['content'] or ''
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.S).strip()
    # A hard token cap must not leave a dangling sentence on the display.
    endings = list(re.finditer(r'(?<![.])[.!?](?![.])(?=\s|$)', text))
    end = endings[-1].end()-1 if endings else -1
    if end >= 30:
        text = text[:end+1]
    if len(text) < 30 or text in HISTORY:
        raise ValueError('No fresh paragraph generated')
    HISTORY.append(text)
    del HISTORY[:-6]
    return {'text':text, 'createdAt':now.isoformat()}

RESULT = None
BUSY = False

def work():
    global RESULT, BUSY
    try:
        RESULT = generate()
    except Exception:
        RESULT = {'error':'The local writer is warming up. Retrying shortly.'}
    finally:
        BUSY = False

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global BUSY, RESULT
        if self.path not in ['/thought','/result']:
            self.send_error(404); return
        with LOCK:
            if self.path == '/thought' and not BUSY:
                BUSY = True; RESULT = None
                threading.Thread(target=work,daemon=True).start()
            result = {'pending':True} if BUSY else RESULT or {'error':'No paragraph yet'}
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        try: self.wfile.write(body)
        except BrokenPipeError: pass

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1',8092), Handler).serve_forever()
