/**
 * 随机点名（放映 / 遥控页）。
 *
 * - 名单：外部文件 `resources/remote-control/names.dll`（实质仍是文本，改名防学生私自修改），一行一个名字（用户可自行增删）。
 * - 语音：`resources/remote-control/sound/<名字>.mp3`，与名单同名；用户可替换。
 *   读取时转成 data URL 交给渲染进程用 <audio> 播放（避免 file:// 跨域/权限问题）。
 * - 不重复：维护“本轮已点”索引集合，全部点过一遍后重置（进入下一轮）。
 * - 显示：点名后在放映窗口所在显示器的顶部居中位置，弹一个无标题、半透明、大字的浮窗，
 *   3 秒后自动关闭，手动点击浮窗也可关闭。
 * - 播放：点名后向所有渲染窗口广播播放事件（渲染进程有 Audio，负责出声）。
 */
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, screen } from 'electron'

/** 资源目录解析优先级：exe 旁覆盖 > 打包 resources > 开发目录。 */
export function rollAssetsDir(): string {
  const candidates = [
    path.join(path.dirname(process.execPath), 'remote-control'),
    path.join(process.resourcesPath, 'remote-control'),
    path.join(__dirname, '../../resources/remote-control'),
    path.join(__dirname, '../resources/remote-control'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[1]
}

/** 本轮已点的名单索引（放下用于“尽量不重复”）。 */
let picked = new Set<number>()

/** 读取名单（去空行）。 */
function loadNames(): string[] {
  try {
    const p = path.join(rollAssetsDir(), 'names.dll')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 随机抽一个未点过的名字；全部点过则重置一轮。 */
function pickName(): string | null {
  const pool = loadNames()
  if (!pool.length) return null
  if (picked.size >= pool.length) picked.clear()
  const remain = pool.map((_, i) => i).filter((i) => !picked.has(i))
  const idx = remain[Math.floor(Math.random() * remain.length)]
  picked.add(idx)
  return pool[idx]
}

/** 读同名 mp3，转 base64 data URL；不存在返回 null。 */
function soundDataUrl(name: string): string | null {
  try {
    const candidate = path.join(rollAssetsDir(), 'sound', `${name}.mp3`)
    if (!existsSync(candidate)) return null
    const buf = readFileSync(candidate)
    return `data:audio/mpeg;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** 顶部居中大字浮窗。 */
let rollWin: BrowserWindow | null = null
function showRollCallWindow(name: string): void {
  if (rollWin && !rollWin.isDestroyed()) {
    try {
      rollWin.close()
    } catch {
      /* ignore */
    }
  }
  // 定位到放映窗口所在的显示器（取当前聚焦窗口，否则第一个窗口），否则主屏
  let disp = screen.getPrimaryDisplay()
  const showWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (showWin && !showWin.isDestroyed()) {
    const d = screen.getDisplayMatching(showWin.getBounds())
    if (d) disp = d
  }
  const W = 960
  const H = 280
  rollWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(disp.workArea.x + (disp.workArea.width - W) / 2),
    y: Math.round(disp.workArea.y + 16),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  })
  // screen-saver 级别高于常规全屏放映窗口，保证点名浮窗始终可见
  rollWin.setAlwaysOnTop(true, 'screen-saver')
  const safe = name.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string))
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:rgba(15,23,42,.92);border-radius:18px;
      display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;
      font-family:"Microsoft YaHei",-apple-system,sans-serif}
    .n{color:#fff;font-size:120px;font-weight:800;letter-spacing:8px;
      text-shadow:0 6px 28px rgba(0,0,0,.6)}
  </style></head><body onclick="window.close()"><div class="n">${safe}</div>
  <script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>`
  void rollWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  rollWin.once('closed', () => {
    rollWin = null
  })
}

/** 执行一次点名：抽签 + 显示浮窗 + 广播播放（返回被点到的名字，供遥控页回显）。 */
export function rollCallPick(): { name: string | null } {
  const name = pickName()
  if (!name) return { name: null }
  const sound = soundDataUrl(name)
  showRollCallWindow(name)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send('slides:roll-call-play', { name, sound })
      } catch {
        /* ignore */
      }
    }
  }
  return { name }
}

/** 读取当前名单（一次性，供遥控页按名字点名/渲染按钮）。 */
export function getRollCallNames(): string[] {
  return loadNames()
}

/** 直接点名某个具体学生（手机名单按钮触发）：弹浮窗 + 广播播放。 */
export function rollCallName(name: string): { name: string | null } {
  if (!name) return { name: null }
  const sound = soundDataUrl(name)
  showRollCallWindow(name)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send('slides:roll-call-play', { name, sound })
      } catch {
        /* ignore */
      }
    }
  }
  return { name }
}

/** 注册随机点名相关 IPC。 */
export function registerRollCallIpc(): void {
  ipcMain.handle('slides:roll-call-pick', () => rollCallPick())
  ipcMain.handle('slides:roll-call-names', () => loadNames())
  // ── 信息呼叫：电脑置顶持续显示文字（带关闭按钮）+ 有同名预录 mp3 则播放一次（录音长度由用户决定）──
  ipcMain.handle('slides:info-call', (_e, text: string) => infoCallText(text))
  ipcMain.handle('slides:info-call-close', () => {
    closeInfoCallWindow()
    return true
  })
}

// ─────────────────────────── 信息呼叫 ───────────────────────────

/** 信息呼叫浮窗（持续显示、带关闭按钮、屏幕级置顶）。 */
let infoWin: BrowserWindow | null = null

/**
 * 信息呼叫预录声音：与常用语同名的 mp3，放在 `resources/remote-control/常用语声音/<文字>.mp3`。
 * 文件名按 Windows 规则清洗（去掉 \ / : * ? " < > |），与 `常用语.txt` 行文字对应。
 * 读取后转 base64 data URL 交给信息浮窗用 <audio> 播放（只播一次，录音长度由用户自己决定）。
 * 找不到则返回 null（静默跳过，不报错）。
 */
function safePresetName(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function infoSoundDataUrl(text: string): string | null {
  try {
    const candidate = path.join(rollAssetsDir(), '常用语声音', `${safePresetName(text)}.mp3`)
    if (!existsSync(candidate)) return null
    const buf = readFileSync(candidate)
    return `data:audio/mpeg;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** 显示信息呼叫浮窗（定位到当前聚焦窗口所在显示器，屏幕级置顶，持续显示直到手动关闭）。 */
function showInfoCallWindow(text: string, sound?: string | null): void {
  if (infoWin && !infoWin.isDestroyed()) {
    try {
      infoWin.close()
    } catch {
      /* ignore */
    }
  }
  // 定位到放映窗口所在的显示器（取当前聚焦窗口，否则第一个窗口），否则主屏
  let disp = screen.getPrimaryDisplay()
  const showWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (showWin && !showWin.isDestroyed()) {
    const d = screen.getDisplayMatching(showWin.getBounds())
    if (d) disp = d
  }
  const W = Math.min(1100, Math.max(520, Math.round(disp.workArea.width * 0.7)))
  const H = 300
  infoWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(disp.workArea.x + (disp.workArea.width - W) / 2),
    y: Math.round(disp.workArea.y + 80),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  })
  // screen-saver 级高于常规全屏放映窗口，保证信息浮窗始终可见
  infoWin.setAlwaysOnTop(true, 'screen-saver')
  const safe = text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string))
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:rgba(15,23,42,.94);border-radius:18px;
      display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;
      font-family:"Microsoft YaHei",-apple-system,sans-serif}
    .msg{color:#fff;font-size:54px;font-weight:800;letter-spacing:4px;text-align:center;
      padding:0 40px;line-height:1.4;text-shadow:0 6px 28px rgba(0,0,0,.6);max-width:100%}
    .close{position:absolute;top:14px;right:18px;width:42px;height:42px;border:none;border-radius:50%;
      background:rgba(255,255,255,.14);color:#fff;font-size:24px;cursor:pointer;line-height:42px}
    .close:active{background:rgba(255,255,255,.3)}
  </style></head><body>
    <button class="close" onclick="window.close()" aria-label="关闭">×</button>
    <div class="msg">${safe}</div>
    ${sound ? `<audio autoplay src="${sound}" id="au" style="display:none"></audio><script>(function(){var a=document.getElementById('au');if(a){a.play().catch(function(){});}})();</script>` : ''}
  </body></html>`
  void infoWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  infoWin.once('closed', () => {
    infoWin = null
  })
}

/** 触发一次信息呼叫：置顶显示文字 + 有同名预录 mp3 则播放一次（录音长度由用户决定）。找不到声音静默跳过。 */
export function infoCallText(text: string): { ok: boolean } {
  if (!text || !text.trim()) return { ok: false }
  const sound = infoSoundDataUrl(text)
  showInfoCallWindow(text, sound)
  return { ok: true }
}

/** 关闭当前信息呼叫浮窗。 */
export function closeInfoCallWindow(): void {
  if (infoWin && !infoWin.isDestroyed()) {
    try {
      infoWin.close()
    } catch {
      /* ignore */
    }
  }
}
