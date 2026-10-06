#!/usr/bin/python3
"""Fixed-purpose native extension bridge, with no arbitrary URL or command inputs."""
import json, struct, sys, time, urllib.request, pathlib

def read_result(path):
    with urllib.request.urlopen('http://127.0.0.1:8092/'+path,timeout=5) as response:
        return json.load(response)

def main():
    size=sys.stdin.buffer.read(4)
    if len(size)!=4:return
    length=struct.unpack('<I',size)[0]
    if length>1024:return
    message=json.loads(sys.stdin.buffer.read(length))
    if message!={'type':'thought'}:return
    try:
        result=read_result('thought')
        for _ in range(58):
            if not result.get('pending'):break
            time.sleep(2)
            result=read_result('result')
        if result.get('pending'):result={'error':'The writer needs a little longer'}
    except Exception:
        result={'error':'Local writing service unavailable'}
    pathlib.Path(__file__).with_name('bridge-status.json').write_text(json.dumps({'ok':'text' in result,'checkedAt':time.time()}))
    body=json.dumps(result).encode()
    sys.stdout.buffer.write(struct.pack('<I',len(body))+body)
    sys.stdout.buffer.flush()

if __name__=='__main__':main()
