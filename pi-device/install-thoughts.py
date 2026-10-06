import json, pathlib, shutil, subprocess
source=pathlib.Path(__file__).parent
extension=pathlib.Path.home()/'.config/marktan-birthday-device'
manifest_path=extension/'manifest.json'
manifest=json.loads(manifest_path.read_text())
manifest['version']='1.3.2'
manifest['host_permissions']=[p for p in manifest['host_permissions'] if p!='http://127.0.0.1/*']
manifest['permissions']=sorted(set(manifest['permissions']+['nativeMessaging']))
native=source/'thoughts-native.py'
native.write_text(native.read_text(), newline='\n')
native.chmod(0o700)
hosts=pathlib.Path.home()/'.config/chromium/NativeMessagingHosts'
hosts.mkdir(parents=True,exist_ok=True)
(hosts/'ai.marktan.thoughts.json').write_text(json.dumps({
    'name':'ai.marktan.thoughts','description':'Local dashboard prose only',
    'path':str(native),'type':'stdio',
    'allowed_origins':['chrome-extension://ofjfjljepmafpleklphhepclkbgepjgj/']}))
profile_hosts=pathlib.Path.home()/'.config/marktan-display-chromium/NativeMessagingHosts'
profile_hosts.mkdir(parents=True,exist_ok=True)
shutil.copyfile(hosts/'ai.marktan.thoughts.json',profile_hosts/'ai.marktan.thoughts.json')
manifest['content_scripts']=[{'matches':['https://pi.marktan.ai/*'],'js':['thoughts-bridge.js'],'run_at':'document_start'}]
for name in ['thoughts-bridge.js','thoughts-background.js']:
    shutil.copyfile(source/name,extension/name)
background=extension/'memory-cache.js'
text=background.read_text()
if "importScripts('thoughts-background.js')" not in text:
    background.write_text("importScripts('thoughts-background.js');\n"+text)
manifest_path.write_text(json.dumps(manifest,indent=2))
units=pathlib.Path.home()/'.config/systemd/user'
runner=next(source.glob('llama-*/llama-server'))
(units/'marktan-llm.service').write_text(f'''[Unit]
Description=Small local model for dashboard prose
[Service]
ExecStart={runner} -m {source}/model-1.7b.gguf --host 127.0.0.1 --port 8091 -t 2 -c 2048 -np 1 --reasoning-budget 0
Nice=10
MemoryMax=1900M
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
''')
(units/'marktan-thoughts.service').write_text(f'''[Unit]
Description=Local dashboard prose service
After=marktan-llm.service
[Service]
ExecStart=/usr/bin/python3 {source}/thoughts-server.py
Nice=10
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
''')
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now','marktan-llm.service','marktan-thoughts.service'],check=True)
print('Local writer installed; existing birthday rules and memories retained.')
