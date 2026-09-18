import json, pathlib, shutil, subprocess
root=pathlib.Path.home()/'.config/marktan-birthday-device'
source=pathlib.Path(__file__).parent
manifest_path=root/'manifest.json'
manifest=json.loads(manifest_path.read_text())
manifest['version']='1.1.0'
manifest['description']='Birthday notices and locally cached published memories for this Pi.'
manifest['permissions']=sorted(set(manifest['permissions']+['alarms']))
manifest['host_permissions']=sorted(set(manifest['host_permissions']+['https://athome.marktan.ai/*']))
manifest['background']={'service_worker':'memory-cache.js'}
manifest['web_accessible_resources']=[{'resources':['memories/*','memory-feed.json'],'matches':['https://pi.marktan.ai/*']}]
shutil.copyfile(source/'memory-cache.js',root/'memory-cache.js')
manifest_path.write_text(json.dumps(manifest,indent=2))
unit=pathlib.Path.home()/'.config/systemd/user'
unit.mkdir(parents=True,exist_ok=True)
(unit/'marktan-memory-sync.service').write_text('''[Unit]
Description=Download published memories for the Pi display
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 %h/.local/lib/marktan-memory-cache/sync-memories.py
TimeoutStartSec=2h
UMask=0077
''')
(unit/'marktan-memory-sync.timer').write_text('''[Unit]
Description=Refresh the local memories library
[Timer]
OnStartupSec=30s
OnUnitInactiveSec=5min
[Install]
WantedBy=timers.target
''')
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now','marktan-memory-sync.timer'],check=True)
print('Memory sync timer installed.')
