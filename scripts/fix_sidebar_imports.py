#!/usr/bin/env python3
"""Remove unused ExternalLink import from Sidebar.tsx"""

path = r'N:\播放器\BiliMusic\src\components\layout\Sidebar.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove ExternalLink line
old_line = "  ExternalLink,\r\n"
if old_line in content:
    content = content.replace(old_line, "")
    print("[OK] Removed ExternalLink (CRLF)")
elif "  ExternalLink,\n" in content:
    content = content.replace("  ExternalLink,\n", "")
    print("[OK] Removed ExternalLink (LF)")
else:
    print("[FAIL] ExternalLink not found")
    exit(1)

# Check if User is used anywhere besides import
import re
user_count = len(re.findall(r'\bUser\b', content))
if user_count <= 1:
    # User is only in import, remove it too
    old_user = "  User,\r\n"
    if old_user in content:
        content = content.replace(old_user, "")
        print("[OK] Removed unused User import (CRLF)")
    elif "  User,\n" in content:
        content = content.replace("  User,\n", "")
        print("[OK] Removed unused User import (LF)")
else:
    print(f"[INFO] User is used {user_count} times, keeping import")

with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(content)
print("Done!")
