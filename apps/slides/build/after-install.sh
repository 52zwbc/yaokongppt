#!/bin/sh
# 遥控PPT（deb）安装后：自动在用户桌面生成快捷启动方式
set -e

DESKTOP_SRC="/usr/share/applications/${executable}.desktop"

[ -f "$DESKTOP_SRC" ] || exit 0

for H in /home/* /root; do
  [ -d "$H" ] || continue
  U=$(basename "$H")
  for D in "$H/Desktop" "$H/桌面"; do
    [ -d "$D" ] || continue
    cp -f "$DESKTOP_SRC" "$D/" 2>/dev/null || continue
    chmod 0755 "$D/${executable}.desktop" 2>/dev/null || true
    chown "$U" "$D/${executable}.desktop" 2>/dev/null || true
    # GNOME 桌面快捷方式需要“信任”标记，双击才会直接启动
    if command -v gio >/dev/null 2>&1; then
      su -s /bin/sh "$U" -c "gio set \"$D/${executable}.desktop\" metadata::trusted true" >/dev/null 2>&1 || true
    fi
  done
done

exit 0