#!/usr/bin/env python3
"""Update version to 1.2.7"""

import json

for fpath in [r'N:\播放器\BiliMusic\package.json', r'N:\播放器\BiliMusic\package-lock.json']:
    with open(fpath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    old_ver = data.get('version', 'N/A')
    data['version'] = '1.2.7'
    
    if 'packages' in data and '' in data['packages']:
        data['packages']['']['version'] = '1.2.7'
    
    with open(fpath, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    
    print(f"[OK] {fpath.split(chr(92))[-1]}: {old_ver} -> 1.2.7")

print("Done!")
