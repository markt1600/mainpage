import importlib.util, pathlib, tempfile, io, json, contextlib
spec=importlib.util.spec_from_file_location('cache',pathlib.Path(__file__).parents[1]/'pi-device/sync-memories.py')
cache=importlib.util.module_from_spec(spec);spec.loader.exec_module(cache)
url='https://athome.marktan.ai/api/memories?action=media&id=a&asset=image.jpg'
feed={'memories':[{'media':[{'src':url}]}]}
class Response(io.BytesIO):
    status=200
    def __init__(self,data,kind):
        super().__init__(data);self.headers={'Content-Type':kind,'Content-Length':str(len(data))}
calls=[]
def request(target,timeout):
    calls.append(target)
    return Response(json.dumps(feed).encode(),'application/json') if target.endswith('display-memories') else Response(b'image-data','image/jpeg')
cache.urllib.request.urlopen=request
with tempfile.TemporaryDirectory() as tmp:
    cache.ROOT=pathlib.Path(tmp);cache.CACHE=cache.ROOT/'memories';cache.RESERVE=0
    cache.sync();assert len(list(cache.CACHE.iterdir()))==1
    index=json.loads((cache.ROOT/'memory-index.json').read_text());assert index[0]['url']==url
    calls.clear();cache.sync();assert len(calls)==1,'Existing asset must not download again'
    feed={'memories':[]};cache.sync();assert not list(cache.CACHE.iterdir()),'Unpublished media must be removed'
    assert json.loads((cache.ROOT/'memory-index.json').read_text())==[]
    feed={'memories':[{'media':[{'src':'http://evil.example/video.mp4'}]}]}
    try:cache.sync();raise AssertionError('Untrusted URL accepted')
    except ValueError:pass
print('Cache tests passed: download, incremental reuse, removal and origin restrictions')
