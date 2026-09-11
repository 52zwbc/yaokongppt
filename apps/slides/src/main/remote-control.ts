/**
 * 放映远程控制（局域网）。
 *
 * 在运行本软件的电脑上起一个 HTTP + WebSocket 服务：
 * - 手机/电脑浏览器访问 `GET /` 拿到远程文件首页（列出「pptx演示器」文件夹、上传、删除、点击打开），
 *   `GET /control` 拿到遥控页（PPTX 控制 / 常用键 / 文本输入 / 鼠标模拟）。
 *   两个页面均为**外部文件** `resources/remote-control/*.html`，运行时读取，便于直接修改替换、无需重新打包。
 * - 遥控页通过 WebSocket 把指令发回本模块，本模块用 **操作系统级** 模拟输入
 *   （Windows `keybd_event` / `SendInput` / `PostMessage`）作用于系统/目标窗口——手机因此等同远程键鼠。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readFile, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { WebSocketServer, type WebSocket } from 'ws'
import QRCode from 'qrcode'
import { clipboard } from 'electron'
import { ipcMain, app, shell, BrowserWindow } from 'electron'
import { rollCallPick, rollCallName, getRollCallNames, infoCallText, closeInfoCallWindow, rollAssetsDir } from './roll-call'

/**
 * 读取常用语列表（每行一语，去空行），供遥控页下拉填充。文件缺失返回空数组。
 * 文件位于 `resources/remote-control/常用语.txt`。
 */
function loadInfoPhrases(): string[] {
  try {
    const p = path.join(rollAssetsDir(), '常用语.txt')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}
import { readLicense, writeLicense, verifyCallback } from './license'
import { createRequire } from 'node:module'

/** 默认端口；被占用时自增重试。 */
const DEFAULT_PORT = 18765

/** Windows 防火墙规则名（按 exe 放行，与端口无关）。 */
const FIREWALL_RULE = 'pptx-presenter-remote'

/** 遥控页 HTML 的资源子路径（打包后位于 resources/remote-control/，asar 之外，可编辑）。 */
const CONTROL_HTML_REL = path.join('remote-control', 'control.html')
/** 上传首页 HTML 的资源子路径（同上）。 */
const INDEX_HTML_REL = path.join('remote-control', 'index.html')

/** Windows 虚拟键码（与物理键盘一致；keybd_event 用这些码，由系统路由到最前方窗口）。 */
const VK = {
  F5: 0x74,
  ESC: 0x1b,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  PRIOR: 0x21, // PageUp
  NEXT: 0x22, // PageDown
  HOME: 0x24,
  END: 0x23,
  SPACE: 0x20,
  RETURN: 0x0d,
  BACK: 0x08,
  LWIN: 0x5b,
  VOLUME_UP: 0xaf,
  VOLUME_DOWN: 0xae,
  VOLUME_MUTE: 0xad,
  MEDIA_PLAY_PAUSE: 0xb3,
  MEDIA_PREV_TRACK: 0xb0,
  MEDIA_NEXT_TRACK: 0xb1,
} as const

/** 手机端按钮 → Windows 虚拟键码。prev/next 即 Left/Right（与放映翻页一致）。 */
const VK_FOR_ACTION: Record<string, number> = {
  start: VK.F5,
  exit: VK.ESC,
  prev: VK.LEFT,
  next: VK.RIGHT,
  left: VK.LEFT,
  right: VK.RIGHT,
  up: VK.UP,
  down: VK.DOWN,
  pgup: VK.PRIOR,
  pgdn: VK.NEXT,
  home: VK.HOME,
  end: VK.END,
  space: VK.SPACE,
  enter: VK.RETURN,
  backspace: VK.BACK,
  win: VK.LWIN,
  volup: VK.VOLUME_UP,
  voldown: VK.VOLUME_DOWN,
  mute: VK.VOLUME_MUTE,
  playpause: VK.MEDIA_PLAY_PAUSE,
  mediaprev: VK.MEDIA_PREV_TRACK,
  medianext: VK.MEDIA_NEXT_TRACK,
}

export interface RemoteControlInfo {
  /** 每个非回环 IPv4 地址一条：url + 该地址的二维码（手机连哪个网段点哪条） */
  entries: { url: string; qr: string }[]
  lanUrl: string
  lanUrls: string[]
  localUrl: string
  port: number
  qr: string
}

let httpServer: ReturnType<typeof createServer> | null = null
let wss: WebSocketServer | null = null
let activePort = 0
let psWorker: ChildProcess | null = null

/** 已连接的 WebSocket 客户端（用于广播注入诊断结果）。 */
const wsClients = new Set<WebSocket>()

/** 广播一条消息给所有已连接客户端。 */
function broadcast(obj: unknown): void {
  const s = JSON.stringify(obj)
  for (const c of wsClients) {
    try {
      c.send(s)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 收到远程放映/翻页等演示控制指令时，先把主窗口唤起：
 * 若程序最小化或置于后台，不唤起来的话，按键会被注入到其它前台窗口，
 * 且用户看不到放映画面。先 restore+show+focus，再注入按键。
 */
function focusSlidesWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 注入引擎（进程形态）。这是左右键成败的关键变量：
 * - 1 常驻 worker（隐藏窗口）
 * - 2 常驻 worker（**可见** PowerShell 窗口，用于验证“无窗口/非交互进程”是否被区别对待）
 * - 3 单次进程（每次点击新起一个 PowerShell，进程形态最接近“手动运行 python 服务”）
 */
let engine = 1
/** 鼠标点击方式：1 SendInput(pynput 同款) 2 SetCursorPos+SendInput 3 mouse_event 4 PostMessage 直投 */
let clickWay = 1

/** 惰性启动常驻 PowerShell worker（仅 Windows）。 */
function ensureWorker(): ChildProcess | null {
  if (psWorker && !psWorker.killed) return psWorker
  if (process.platform !== 'win32') return null
  try {
    psWorker = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_WORKER], {
      // 引擎2：保留可见窗口（验证进程形态假设）
      windowsHide: engine !== 2,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    psWorker.on('error', () => { psWorker = null })
    psWorker.on('exit', () => { psWorker = null })
    // 诊断回传：点击类指令会打印 R:<n>，n = 实际注入成功的事件数
    psWorker.stdout?.on('data', (buf: Buffer) => {
      const txt = buf.toString()
      const m = /R:(-?\d+)/.exec(txt)
      if (m) broadcast({ type: 'diag', text: `注入返回值 ${m[1]}（1~2=成功；0=被系统拒绝）` })
    })
    return psWorker
  } catch {
    return null
  }
}

/** 关闭常驻 worker（切换引擎时需要）。 */
function killWorker(): void {
  if (psWorker) {
    try {
      psWorker.kill()
    } catch {
      /* ignore */
    }
    psWorker = null
  }
}

/** 发送一行指令：引擎3 走单次进程；否则优先常驻 worker（低延迟），失败回退单次进程。 */
function sendLine(line: string): void {
  if (process.platform !== 'win32') return
  if (engine === 3) {
    runOnce(line)
    return
  }
  const w = ensureWorker()
  if (w && w.stdin && w.stdin.writable) {
    try {
      w.stdin.write(line + '\n')
      return
    } catch {
      /* worker 失联，落到兜底 */
    }
  }
  runOnce(line)
}

/** 单次 PowerShell 进程执行一条指令（兜底 / 引擎3）。 */
function runOnce(line: string): void {
  const ps = lineToPs(line)
  if (!ps) return
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${PS_CLASS}\n${ps}\n`], { windowsHide: true }, (err, stdout) => {
    if (err) {
      console.warn('[remote-control] 注入失败：', err.message)
      return
    }
    const m = stdout ? /R:(-?\d+)/.exec(String(stdout)) : null
    if (m) broadcast({ type: 'diag', text: `注入返回值 ${m[1]}（1~2=成功；0=被系统拒绝）` })
  })
}

/** 取所有非内部 IPv4 地址。 */
function lanIps(): string[] {
  const out: string[] = []
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

/** 页面 HTML 的读取路径（按优先级：exe 旁覆盖 > 打包 resources > 开发目录）。首个存在者生效。 */
function remotePagePath(rel: string): string {
  const base = path.basename(rel)
  const candidates = [
    path.join(path.dirname(process.execPath), 'remote-control', base),
    path.join(process.resourcesPath, rel),
    path.join(__dirname, '../../resources/remote-control', base),
    path.join(__dirname, '../resources/remote-control', base),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return candidates[1]
}

/**
 * 远程上传文件夹：优先「文档\pptx演示器」，无权限/失败则回退到 exe 旁（便携场景），最后 userData。
 * 通过真实写入探针文件确认可写，避免“目录建好了却写不进”的假成功。
 */
function uploadDir(): string {
  const probe = (dir: string): string | null => {
    try {
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, '.probe')
      const fd = openSync(f, 'w')
      closeSync(fd)
      unlinkSync(f)
      return dir
    } catch {
      return null
    }
  }
  const candidates = [
    path.join(app.getPath('documents'), 'pptx演示器'),
    path.isAbsolute(process.execPath) ? path.join(path.dirname(process.execPath), 'pptx演示器') : '',
    path.join(app.getPath('userData'), 'pptx演示器'),
  ]
  for (const c of candidates) {
    if (!c) continue
    const ok = probe(c)
    if (ok) return ok
  }
  return candidates[candidates.length - 1]
}

/** 校验文件名：只允许“纯文件名”，拒绝路径穿越（../、盘符、斜杠、反斜杠）。 */
function safeFileName(name: string): string | null {
  if (!name || name.length > 200) return null
  if (name !== path.basename(name)) return null
  if (/[\\/:*?"<>|]/.test(name)) return null
  if (name === '.' || name === '..') return null
  return name
}

/**
 * 尽力为本程序 exe 添加 Windows 防火墙入站放行规则。
 * 根因修复：localhost 回环默认绕过防火墙，故本机能开、手机不能；放行后手机可连。
 */
function ensureFirewallRule(): void {
  if (process.platform !== 'win32') return
  const exe = process.execPath
  const args = [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${FIREWALL_RULE}`,
    'dir=in', 'action=allow',
    `program=${exe}`,
    'enable=yes', 'profile=any',
  ]
  try {
    execFile('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`], () => {
      execFile('netsh', args, (err) => {
        if (err) console.warn('[remote-control] 自动添加防火墙规则失败（可能需要以管理员身份运行）：', err.message)
        else console.log('[remote-control] 已添加 Windows 防火墙放行规则：', FIREWALL_RULE)
      })
    })
  } catch (e) {
    console.warn('[remote-control] 防火墙规则操作异常：', (e as Error)?.message)
  }
}

/**
 * PowerShell：定义 keybd_event（键盘）/ SendInput（鼠标）/ PostMessage（点击直投）的 C# 包装（一次性）。
 * - 键盘用 keybd_event（无结构体、无 cbSize 陷阱，已验证可用）。
 * - 鼠标移动/滚轮用 SendInput + MOUSEINPUT 结构体（已验证可用）。
 * - 鼠标**按键**的可靠方案是 PostMessage 直投：取当前光标处窗口，把 WM_LBUTTONDOWN/UP、
 *   WM_RBUTTONDOWN/UP 直接投进它的消息队列——不经过系统输入队列，因此**完全不受前台锁抑制**，
 *   也不碰任何线程的输入队列（绝无物理键盘被拖住的风险）。
 *   （SendInput/mouse_event 的按钮事件会被 Windows 前台锁丢弃：后台进程注入时只有移动/滚轮生效。）
 * - Paste() 把 Ctrl+V 的四条 keybd_event 合并成一个原子调用，杜绝“只按下没抬起”导致 Ctrl 卡住。
 * 注意：所有 out 参数用显式变量（部分 PowerShell 的 C# 编译器不支持 `out _`）。
 */
const PS_CLASS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RCKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, MINPUT[] p, int cb);
  public const uint KEYUP = 2;
  public const uint M_LEFTDOWN = 0x0002, M_LEFTUP = 0x0004, M_RIGHTDOWN = 0x0008, M_RIGHTUP = 0x0010, M_MOVE = 0x0001, M_WHEEL = 0x0800;
  [StructLayout(LayoutKind.Sequential)] public struct MINPUT { public int type; public MI u; }
  [StructLayout(LayoutKind.Explicit)] public struct MI { [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  public static void Tap(byte v) { keybd_event(v,0,0,UIntPtr.Zero); keybd_event(v,0,KEYUP,UIntPtr.Zero); }
  public static void KeyDown(byte v) { keybd_event(v,0,0,UIntPtr.Zero); }
  public static void KeyUp(byte v) { keybd_event(v,0,KEYUP,UIntPtr.Zero); }
  public static void Paste() {
    keybd_event(0x11,0,0,UIntPtr.Zero);
    keybd_event(0x56,0,0,UIntPtr.Zero);
    keybd_event(0x56,0,KEYUP,UIntPtr.Zero);
    keybd_event(0x11,0,KEYUP,UIntPtr.Zero);
  }
  static void Mk(uint flags, uint data, int dx, int dy) {
    MINPUT[] i = new MINPUT[1];
    i[0].type = 0;
    i[0].u.mi = new MOUSEINPUT(){ dx = dx, dy = dy, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    SendInput(1, i, Marshal.SizeOf(typeof(MINPUT)));
  }
  public static void MouseMove(int dx, int dy) { Mk(M_MOVE, 0, dx, dy); }
  public static void Wheel(int d) { Mk(M_WHEEL, (uint)d, 0, 0); }

  // ── 鼠标按键：4 种方式，均返回 SendInput 实际注入的事件数（0 = 被系统拒绝/前台锁拦截）──
  // 方式1（pynput 同款）：两次独立 SendInput，先 down 后 up，结构体只填 dwFlags
  public static int SDown(uint f) {
    MINPUT[] i = new MINPUT[1];
    i[0].type = 0; i[0].u.mi = new MOUSEINPUT(){ dwFlags = f, time = 0, dwExtraInfo = IntPtr.Zero };
    return (int)SendInput(1, i, Marshal.SizeOf(typeof(MINPUT)));
  }
  public static int SUp(uint f) {
    MINPUT[] i = new MINPUT[1];
    i[0].type = 0; i[0].u.mi = new MOUSEINPUT(){ dwFlags = f << 1, time = 0, dwExtraInfo = IntPtr.Zero };
    return (int)SendInput(1, i, Marshal.SizeOf(typeof(MINPUT)));
  }
  public static int SClick(uint f) { int a = SDown(f); System.Threading.Thread.Sleep(30); int b = SUp(f); return a + b; }

  // ── PostMessage 直投（鼠标按键专用）──
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  static IntPtr HoverWnd = IntPtr.Zero;
  static IntPtr LParam(POINT p) { return (IntPtr)(((long)(uint)p.Y << 16) | ((uint)p.X & 0xFFFF)); }
  // 方式2：先用 SetCursorPos 把光标“钉”在当前位置（刷新系统对光标的认知），再 SendInput
  public static int ClickAt(uint f) {
    POINT p;
    GetCursorPos(out p);
    SetCursorPos(p.X, p.Y);
    return SClick(f);
  }
  // 方式3：老 API mouse_event
  public static int LClick(uint f) {
    mouse_event(f, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(f << 1, 0, 0, 0, UIntPtr.Zero);
    return 2;
  }
  // 方式4：PostMessage 直投到光标处窗口（绕过系统输入队列，不受前台锁影响）
  public static void PostDown(uint btn) {
    POINT p;
    GetCursorPos(out p);
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return;
    HoverWnd = h;
    ScreenToClient(h, ref p);
    IntPtr lp = LParam(p);
    if (btn == 2) PostMessage(h, 0x0201, (IntPtr)0x0001, lp);
    else PostMessage(h, 0x0204, (IntPtr)0x0002, lp);
  }
  public static void PostUp(uint btn) {
    POINT p;
    GetCursorPos(out p);
    IntPtr h = HoverWnd != IntPtr.Zero ? HoverWnd : WindowFromPoint(p);
    HoverWnd = IntPtr.Zero;
    if (h == IntPtr.Zero) return;
    ScreenToClient(h, ref p);
    IntPtr lp = LParam(p);
    if (btn == 2) PostMessage(h, 0x0202, (IntPtr)0, lp);
    else PostMessage(h, 0x0205, (IntPtr)0, lp);
  }
  public static int PostClick(uint btn) {
    PostDown(btn);
    System.Threading.Thread.Sleep(40);
    PostUp(btn);
    return 2;
  }
}
'@
`

/**
 * 常驻 PowerShell worker：从 stdin 逐行读取指令并派发（避免每次按键都启动进程）。
 * 命令字符用数字表示“鼠标按键类”（PowerShell 的 -eq 对字符串大小写不敏感，避免与 k/d/u 冲突）。
 * 有返回值的点击指令会打印 `R:<n>`：n 为实际注入成功的事件数，0 表示被系统拒绝。
 */
const PS_LOOP = `
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null) { break }
  try {
    $cmd = $l.Substring(0,1); $a = $l.Substring(1)
    if ($cmd -eq 'k') { [RCKey]::Tap([byte]::Parse($a)) }
    elseif ($cmd -eq 'd') { [RCKey]::KeyDown([byte]::Parse($a)) }
    elseif ($cmd -eq 'u') { [RCKey]::KeyUp([byte]::Parse($a)) }
    elseif ($cmd -eq 'm') { $p = $a.Split(','); [RCKey]::MouseMove([int]::Parse($p[0]), [int]::Parse($p[1])) }
    elseif ($cmd -eq 'w') { [RCKey]::Wheel([int]::Parse($a)) }
    elseif ($cmd -eq 'v') { [RCKey]::Paste() }
    elseif ($cmd -eq '1') { $r = [RCKey]::SClick([uint]::Parse($a)); Write-Output "R:$r" }
    elseif ($cmd -eq '2') { $r = [RCKey]::SDown([uint]::Parse($a)); Write-Output "R:$r" }
    elseif ($cmd -eq '3') { $r = [RCKey]::SUp([uint]::Parse($a)); Write-Output "R:$r" }
    elseif ($cmd -eq '4') { $r = [RCKey]::ClickAt([uint]::Parse($a)); Write-Output "R:$r" }
    elseif ($cmd -eq '5') { $r = [RCKey]::LClick([uint]::Parse($a)); Write-Output "R:$r" }
    elseif ($cmd -eq '6') { $r = [RCKey]::PostClick([uint]::Parse($a)); Write-Output "R:$r" }
    elseif ($cmd -eq '7') { [RCKey]::PostDown([uint]::Parse($a)) }
    elseif ($cmd -eq '8') { [RCKey]::PostUp([uint]::Parse($a)) }
  } catch {}
}
`

/** 单次调用版：把一行指令转成对应 C# 调用（worker 不可用或“单次进程”引擎时使用）。 */
function lineToPs(line: string): string {
  const cmd = line[0]
  const a = line.slice(1)
  switch (cmd) {
    case 'k': return `[RCKey]::Tap([byte]::Parse('${a}'))`
    case 'd': return `[RCKey]::KeyDown([byte]::Parse('${a}'))`
    case 'u': return `[RCKey]::KeyUp([byte]::Parse('${a}'))`
  case 'm': { const [dx, dy] = a.split(','); return `[RCKey]::MouseMove([int]::Parse('${dx}'),[int]::Parse('${dy}'))` }
  case 'w': return `[RCKey]::Wheel([int]::Parse('${a}'))`
  case 'v': return `[RCKey]::Paste()`
  case '1': return `$r=[RCKey]::SClick([uint]::Parse('${a}')); Write-Output "R:$r"`
  case '2': return `$r=[RCKey]::SDown([uint]::Parse('${a}')); Write-Output "R:$r"`
  case '3': return `$r=[RCKey]::SUp([uint]::Parse('${a}')); Write-Output "R:$r"`
  case '4': return `$r=[RCKey]::ClickAt([uint]::Parse('${a}')); Write-Output "R:$r"`
  case '5': return `$r=[RCKey]::LClick([uint]::Parse('${a}')); Write-Output "R:$r"`
  case '6': return `$r=[RCKey]::PostClick([uint]::Parse('${a}')); Write-Output "R:$r"`
  case '7': return `[RCKey]::PostDown([uint]::Parse('${a}'))`
  case '8': return `[RCKey]::PostUp([uint]::Parse('${a}'))`
    default: return ''
  }
}

const PS_WORKER = `${PS_CLASS}\n${PS_LOOP}`

// ── 鼠标模拟：优先用 koffi 在 Electron 主进程（前台窗口进程）直接调 user32.dll ──
// 参考 D:\py\yaokong\nodeyaokong：它用 koffi 直调 mouse_event，左右键模拟正常。
// 之前用 PowerShell 子进程注入 SendInput/mouse_event 会被 Windows 前台锁丢弃（后台进程的按钮事件不生效），
// 主进程本身是前台进程，直调 user32 不受此限。koffi 不可用时回退原有 PowerShell 方案。
const nodeRequire = createRequire(__filename)
interface RcMouseApi {
  M: { MOVE: number; LEFTDOWN: number; LEFTUP: number; RIGHTDOWN: number; RIGHTUP: number; MIDDLEDOWN: number; MIDDLEUP: number; WHEEL: number }
  mouse_event: (flags: number, dx: number, dy: number, data: number, extra: unknown) => void
  SetCursorPos: (x: number, y: number) => number
}
let rcMouseApi: RcMouseApi | null = null
let rcMouseApiTried = false
function loadMouseApi(): RcMouseApi | null {
  if (rcMouseApiTried) return rcMouseApi
  rcMouseApiTried = true
  if (process.platform !== 'win32') return null
  try {
    const koffi = nodeRequire('koffi')
    const user32 = koffi.load('user32.dll')
    const mouse_event = user32.func('void mouse_event(int dwFlags, int dx, int dy, int dwData, void* dwExtraInfo)')
    const SetCursorPos = user32.func('int SetCursorPos(int X, int Y)')
    rcMouseApi = {
      M: { MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010, MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800 },
      mouse_event: (flags, dx, dy, data, extra) => mouse_event(flags, dx, dy, data, extra as unknown as void),
      SetCursorPos: (x, y) => SetCursorPos(x, y),
    }
  } catch (e) {
    console.warn('[remote-control] koffi 鼠标直调初始化失败，回退 PowerShell 方案：', (e as Error)?.message)
    rcMouseApi = null
  }
  return rcMouseApi
}

// ── 显示桌面（Win+D）：用 koffi 直调 user32.keybd_event 发送组合键 ──
let rcKeybdApi: ((vk: number, scan: number, flags: number, extra: unknown) => void) | null = null
let rcKeybdTried = false
function loadKeybdApi(): ((vk: number, scan: number, flags: number, extra: unknown) => void) | null {
  if (rcKeybdTried) return rcKeybdApi
  rcKeybdTried = true
  if (process.platform !== 'win32') return null
  try {
    const koffi = nodeRequire('koffi')
    const user32 = koffi.load('user32.dll')
    rcKeybdApi = user32.func('void keybd_event(byte bVk, byte bScan, uint dwFlags, void* dwExtraInfo)')
  } catch {
    rcKeybdApi = null
  }
  return rcKeybdApi
}

// ── Linux 键鼠模拟：用 koffi 直调 XTest（X11 扩展，与 xdotool 同源）──
// XTest 事件由 X server 注入到全局输入队列，会投递到当前焦点窗口；因此先
// focusSlidesWindow() 唤起本软件窗口，再注入按键/鼠标即可（与 Windows 语义一致）。
// 依赖系统 libXtst/libX11（deb 安装包已自动声明 libxtst6 依赖；纯 Wayland 无
// DISPLAY 时 XOpenDisplay 失败，将整体降级为 no-op）。
interface RcLinuxX11Api {
  display: unknown
  XStringToKeysym: (name: string) => number
  XKeysymToKeycode: (display: unknown, keysym: number) => number
  XTestFakeKeyEvent: (display: unknown, keycode: number, isPress: number, delay: number) => number
  XTestFakeRelativeMotionEvent: (display: unknown, dx: number, dy: number, delay: number) => number
  XTestFakeButtonEvent: (display: unknown, button: number, isPress: number, delay: number) => number
  XFlush: (display: unknown) => number
}
let rcLinuxX11: RcLinuxX11Api | null = null
let rcLinuxX11Tried = false
function loadLinuxX11Api(): RcLinuxX11Api | null {
  if (rcLinuxX11Tried) return rcLinuxX11
  rcLinuxX11Tried = true
  if (process.platform !== 'linux') return null
  try {
    const koffi = nodeRequire('koffi')
    const X11 = koffi.load('libX11.so.6')
    const Xtst = koffi.load('libXtst.so.6')
    const XOpenDisplay = X11.func('void* XOpenDisplay(char* display_name)')
    const display = XOpenDisplay(null)
    if (!display) throw new Error('XOpenDisplay 失败（当前会话没有 X DISPLAY？）')
    // XTest 各函数最后一个参数 delay 为毫秒；此处统一传 0 立即发送，调用后 XFlush 保证落到服务器
    rcLinuxX11 = {
      display,
      XStringToKeysym: X11.func('long XStringToKeysym(char* string)'),
      XKeysymToKeycode: X11.func('int XKeysymToKeycode(void* dpy, long keysym)'),
      XTestFakeKeyEvent: Xtst.func('int XTestFakeKeyEvent(void* dpy, unsigned int keycode, int is_press, unsigned long delay)'),
      XTestFakeRelativeMotionEvent: Xtst.func('int XTestFakeRelativeMotionEvent(void* dpy, int dx, int dy, unsigned long delay)'),
      XTestFakeButtonEvent: Xtst.func('int XTestFakeButtonEvent(void* dpy, unsigned int button, int is_press, unsigned long delay)'),
      XFlush: X11.func('int XFlush(void* dpy)'),
    }
  } catch (e) {
    console.warn('[remote-control] Linux XTest 初始化失败，键鼠模拟不可用：', (e as Error)?.message)
    rcLinuxX11 = null
  }
  return rcLinuxX11
}

/** Windows 虚拟键码 → X11 keysym 名（XStringToKeysym 可解析）。 */
const LINUX_KEYSYM_FOR_VK: Record<number, string> = {
  [VK.F5]: 'F5',
  [VK.ESC]: 'Escape',
  [VK.LEFT]: 'Left',
  [VK.UP]: 'Up',
  [VK.RIGHT]: 'Right',
  [VK.DOWN]: 'Down',
  [VK.PRIOR]: 'Prior',
  [VK.NEXT]: 'Next',
  [VK.HOME]: 'Home',
  [VK.END]: 'End',
  [VK.SPACE]: 'space',
  [VK.RETURN]: 'Return',
  [VK.BACK]: 'BackSpace',
  [VK.LWIN]: 'Super_L',
  [VK.VOLUME_UP]: 'XF86AudioRaiseVolume',
  [VK.VOLUME_DOWN]: 'XF86AudioLowerVolume',
  [VK.VOLUME_MUTE]: 'XF86AudioMute',
  [VK.MEDIA_PLAY_PAUSE]: 'XF86AudioPlay',
  [VK.MEDIA_PREV_TRACK]: 'XF86AudioPrev',
  [VK.MEDIA_NEXT_TRACK]: 'XF86AudioNext',
}

/** 单键点按（按下→短暂延时→抬起），走 XTest 全局注入。 */
function linuxTapKey(vk: number): boolean {
  const api = loadLinuxX11Api()
  if (!api) return false
  const name = LINUX_KEYSYM_FOR_VK[vk]
  if (!name) return false
  try {
    const code = api.XKeysymToKeycode(api.display, api.XStringToKeysym(name))
    if (!code) return false
    api.XTestFakeKeyEvent(api.display, code, 1, 0)
    api.XFlush(api.display)
    setTimeout(() => {
      try {
        api.XTestFakeKeyEvent(api.display, code, 0, 0)
        api.XFlush(api.display)
      } catch { /* 忽略 */ }
    }, 15)
    return true
  } catch {
    return false
  }
}

/** 组合键：按下 press 列出的修饰键，点按一次 action 键，再按逆序松开修饰键。
 *  用于 Ctrl+V 粘贴与 Super+D 显示桌面。 */
function linuxChord(
  press: string[],
  action: string,
  release: string[],
): boolean {
  const api = loadLinuxX11Api()
  if (!api) return false
  try {
    const code = (name: string) => api.XKeysymToKeycode(api.display, api.XStringToKeysym(name))
    const down: number[] = []
    for (const p of press) {
      const c = code(p)
      if (!c) return false
      down.push(c)
      api.XTestFakeKeyEvent(api.display, c, 1, 0)
    }
    const ac = code(action)
    if (!ac) return false
    api.XTestFakeKeyEvent(api.display, ac, 1, 0)
    api.XTestFakeKeyEvent(api.display, ac, 0, 0)
    for (const c of [...down].reverse()) api.XTestFakeKeyEvent(api.display, c, 0, 0)
    api.XFlush(api.display)
    return true
  } catch {
    return false
  }
}

/** Linux 显示桌面：Super+D（与 Windows Win+D 语义对应）。 */
function linuxShowDesktop(): boolean {
  return linuxChord(['Super_L'], 'd', ['Super_L'])
}

/** Linux 原子粘贴：Ctrl+V（剪贴板已写好文本）。 */
function linuxPasteKey(): boolean {
  return linuxChord(['Control_L'], 'v', ['Control_L'])
}

/** XTest 鼠标按键号：左=1 右=3（f 为 Windows 风格标志：0x0002 左 / 0x0008 右）。 */
function linuxBtnNumber(f: number): number {
  return f === 0x0008 ? 3 : 1
}
/** Linux 按键按下。 */
function linuxMouseDown(f: number): boolean {
  const api = loadLinuxX11Api()
  if (!api) return false
  try {
    api.XTestFakeButtonEvent(api.display, linuxBtnNumber(f), 1, 0)
    api.XFlush(api.display)
    return true
  } catch {
    return false
  }
}
/** Linux 按键抬起。 */
function linuxMouseUp(f: number): boolean {
  const api = loadLinuxX11Api()
  if (!api) return false
  try {
    api.XTestFakeButtonEvent(api.display, linuxBtnNumber(f), 0, 0)
    api.XFlush(api.display)
    return true
  } catch {
    return false
  }
}
/** Linux 相对移动。 */
function linuxMouseMove(dx: number, dy: number): boolean {
  const api = loadLinuxX11Api()
  if (!api) return false
  try {
    api.XTestFakeRelativeMotionEvent(api.display, dx, dy, 0)
    api.XFlush(api.display)
    return true
  } catch {
    return false
  }
}
/** Linux 滚轮：button 4=上、5=下，每毫步一格；delta 大时按比例多点几下。 */
function linuxWheel(d: number): boolean {
  const api = loadLinuxX11Api()
  if (!api) return false
  const steps = Math.max(1, Math.min(8, Math.round(Math.abs(d) / 100) || 1))
  const btn = d > 0 ? 4 : 5
  try {
    for (let i = 0; i < steps; i++) {
      api.XTestFakeButtonEvent(api.display, btn, 1, 0)
      api.XTestFakeButtonEvent(api.display, btn, 0, 0)
    }
    api.XFlush(api.display)
    return true
  } catch {
    return false
  }
}

/** 显示桌面：按下 Super，按下并松开 D，再松开 Super（等同 Win+D）。供放映导航“显示桌面”按钮调用。 */
export function showDesktop(): void {
  if (process.platform === 'linux') {
    linuxShowDesktop()
    return
  }
  if (process.platform !== 'win32') return
  const k = loadKeybdApi()
  if (!k) {
    console.warn('[remote-control] keybd_event 不可用，无法显示桌面')
    return
  }
  const KEYUP = 0x0002
  const LWIN = 0x5b
  const D = 0x44
  k(LWIN, 0, 0, null)
  k(D, 0, 0, null)
  k(D, 0, KEYUP, null)
  k(LWIN, 0, KEYUP, null)
}
/** 鼠标左/右键按下；返回 true 表示已注入（Windows 走 koffi/PS、Linux 走 XTest）。 */
function koffiBtnDown(f: number): boolean {
  if (process.platform === 'linux') return linuxMouseDown(f)
  const api = loadMouseApi()
  if (!api) return false
  api.mouse_event(f === 0x0008 ? api.M.RIGHTDOWN : api.M.LEFTDOWN, 0, 0, 0, null)
  return true
}
/** 鼠标左/右键抬起；返回 true 表示已注入。 */
function koffiBtnUp(f: number): boolean {
  if (process.platform === 'linux') return linuxMouseUp(f)
  const api = loadMouseApi()
  if (!api) return false
  api.mouse_event(f === 0x0008 ? api.M.RIGHTUP : api.M.LEFTUP, 0, 0, 0, null)
  return true
}
/** 相对移动（与 SendInput M_MOVE 同义：无 ABS 标志即相对位移）。 */
function koffiMove(dx: number, dy: number): boolean {
  if (process.platform === 'linux') return linuxMouseMove(dx, dy)
  const api = loadMouseApi()
  if (!api) return false
  api.mouse_event(api.M.MOVE, dx, dy, 0, null)
  return true
}
/** 滚轮：data>0 向上（与 SendInput M_WHEEL 同义）。 */
function koffiWheel(d: number): boolean {
  if (process.platform === 'linux') return linuxWheel(d)
  const api = loadMouseApi()
  if (!api) return false
  api.mouse_event(api.M.WHEEL, 0, 0, d, null)
  return true
}

// 基础动作封装（行协议）
const tapKey = (vk: number) => { if (!linuxTapKey(vk)) sendLine(`k${vk}`) }
const mouseMove = (dx: number, dy: number) => { if (!koffiMove(dx, dy)) sendLine(`m${dx},${dy}`) }
const wheel = (d: number) => { if (!koffiWheel(d)) sendLine(`w${d}`) }
/** 原子粘贴：Ctrl+V（Win 为合成一次性 C# 调用；Linux 为 XTest 组合键），绝无“Ctrl 只按下未抬起”。 */
const pasteKey = () => { if (!linuxPasteKey()) sendLine('v') }

/**
 * 鼠标按键：优先 koffi 直接调 user32（前台进程，左右键稳定生效）；
 * koffi 不可用时回退原 PowerShell 多方式分派（clickWay 1-4）。
 */
function clickMouse(f: number): void {
  if (koffiBtnDown(f)) { setTimeout(() => koffiBtnUp(f), 30); return }
  if (clickWay === 2) sendLine(`4${f}`)
  else if (clickWay === 3) sendLine(`5${f}`)
  else if (clickWay === 4) sendLine(`6${f}`)
  else sendLine(`1${f}`)
}
function pressMouse(f: number): void {
  if (koffiBtnDown(f)) return
  if (clickWay === 4) sendLine(`7${f}`)
  else sendLine(`2${f}`)
}
function releaseMouse(f: number): void {
  if (koffiBtnUp(f)) return
  if (clickWay === 4) sendLine(`8${f}`)
  else sendLine(`3${f}`)
}

/** 把文本以“粘贴”方式插入到电脑当前光标处（剪贴板临时写入 + 原子 Ctrl+V，随后恢复剪贴板）。
 *  Windows 与 Linux 均支持（Linux 走 XTest 组合键）。 */
function insertText(text: string): void {
  if (process.platform !== 'win32' && process.platform !== 'linux') return
  try {
    const prev = clipboard.readText()
    clipboard.writeText(text)
    pasteKey()
    setTimeout(() => {
      try {
        clipboard.writeText(prev)
      } catch {
        /* ignore */
      }
    }, 350)
  } catch (e) {
    console.warn('[remote-control] 文本插入失败：', (e as Error)?.message)
  }
}

/** 极简兜底页面（仅当外部 control.html 缺失时启用，保证功能不彻底失效）。 */
const FALLBACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>放映遥控</title>
<style>body{background:#0f172a;color:#e2e8f0;font-family:sans-serif;text-align:center;padding:24px}
button{display:block;width:80%;margin:10px auto;padding:18px;font-size:18px;border:none;border-radius:14px;background:#2563eb;color:#fff}
a{color:#60a5fa}.status{margin:10px}</style></head><body><h1>放映遥控</h1>
<div id="status" class="status">未连接</div>
<button data-action="start">▶ 放映</button><button data-action="prev">前页</button>
<button data-action="next">后页</button><button data-action="exit">退出</button>
<script>var s=document.getElementById('status'),ws=null;function set(o,t){s.textContent=t;s.className='status '+(o?'on':'off')}
function c(){ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);ws.onopen=function(){set(1,'已连接')};ws.onclose=function(){set(0,'重连中');setTimeout(c,1500)};ws.onerror=function(){try{ws.close()}catch(e){}}}
document.querySelectorAll('button[data-action]').forEach(function(b){b.onclick=function(){if(ws&&ws.readyState===1)ws.send(JSON.stringify({action:b.dataset.action}))}});c()</script>
</body></html>`

// ── 远程文件打开回调：由 slides-main 注册（复用现有 openAndBuild 机制在软件内打开）──
type RemoteOpenHandler = (path: string) => Promise<boolean>
let remoteOpenHandler: RemoteOpenHandler | null = null
export function setRemoteOpenHandler(fn: RemoteOpenHandler | null): void {
  remoteOpenHandler = fn
}

/** 列出上传文件夹内的文件（按修改时间降序，新文件在前）。 */
function listUploadFiles(dir: string): { name: string; size: number; mtime: number }[] {
  try {
    const out: { name: string; size: number; mtime: number }[] = []
    for (const name of readdirSync(dir)) {
      try {
        const st = statSync(path.join(dir, name))
        if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs })
      } catch {
        /* 单个文件统计失败跳过 */
      }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  } catch {
    return []
  }
}

/** 发送 JSON 响应（手机轮询用，禁缓存）。 */
function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/** 发送 HTML 页面（外部文件缺失时回退到兜底页）。 */
function sendPage(res: ServerResponse, rel: string): void {
  const p = remotePagePath(rel)
  readFile(p, 'utf8', (err, html) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Connection': 'close', 'Cache-Control': 'no-store' })
    res.end(err || !html ? FALLBACK_HTML : html)
  })
}

// ───────────────────────── 防盗版：Web 服务端验证拦截 ─────────────────────────
// 触发点：手机/浏览器访问远程控制地址时，由本服务端决定放行还是 302 到验证页。
const VERIFY_URL = 'https://www.52zwbc.com/liteppt/index.php'
const STATIC_EXT = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.json']

let lastReachCheck = 0
let lastReachOk = false
/** 探测验证网站是否可达（带 5 分钟缓存，避免每次请求都联网）。 */
async function isVerifySiteReachable(): Promise<boolean> {
  const now = Date.now()
  if (now - lastReachCheck < 5 * 60 * 1000) return lastReachOk
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 3500)
    const r = await fetch(VERIFY_URL, { method: 'HEAD', signal: ctl.signal as unknown as AbortSignal })
    clearTimeout(timer)
    lastReachOk = r.status < 500
    lastReachCheck = now
    return lastReachOk
  } catch {
    lastReachOk = false
    lastReachCheck = now
    return false
  }
}

/**
 * 防盗版闸门。返回 true 表示已处理响应（已 302，调用方应 return）；false 表示放行。
 *  - 回跳带有效 sig：校验通过则写本地机器绑定记录并放行
 *  - 已有本地记录：放行
 *  - 需验证：网站可达则 302 到验证页（带 redirect=当前完整 URL）；不可达则临时放行
 */
async function maybeGate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  // 静态资源放行（页面依赖，避免样式/脚本加载失败）
  const ext = path.extname(url.pathname).toLowerCase()
  if (req.method === 'GET' && STATIC_EXT.includes(ext)) return false

  // 1) 验证回跳：sig 有效则写记录并放行
  const sig = url.searchParams.get('sig')
  const phone = url.searchParams.get('phone')
  const ts = url.searchParams.get('ts')
  if (sig && phone && ts && verifyCallback(phone, ts, sig)) {
    try {
      writeLicense(phone)
      console.log('[remote-control] 验证通过，已写入本地授权记录，下次免验证')
    } catch (e) {
      console.error('[remote-control] 写入本地授权记录失败：', (e as Error)?.message)
    }
    return false
  }

  // 2) 已有本地记录：放行
  try { if (readLicense()) return false } catch { /* ignore */ }

  // 3) 需验证：探测网站可达性
  let reachable = false
  try { reachable = await isVerifySiteReachable() } catch { reachable = false }
  if (!reachable) {
    console.warn('[remote-control] 验证网站不可达，临时放行远程控制')
    return false
  }

  // 4) 可达：302 到验证页（redirect=当前完整 URL；清掉可能残留的无效 sig 参数避免回跳死循环）
  const back = new URL(url.origin + url.pathname + url.search)
  back.searchParams.delete('sig')
  back.searchParams.delete('phone')
  back.searchParams.delete('ts')
  const target = VERIFY_URL + '?redirect=' + encodeURIComponent(back.toString())
  res.writeHead(302, { 'Location': target, 'Connection': 'close', 'Cache-Control': 'no-store' })
  res.end()
  return true
}

async function startRemoteControl(): Promise<RemoteControlInfo> {
  if (httpServer) {
    return buildInfo(activePort)
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const route = url.pathname.replace(/\/+$/, '') || '/'

    // 防盗版：浏览器访问远程控制地址时，无本地记录则 302 到验证页；网站不可达则临时放行
    if (await maybeGate(req, res, url)) return

    // 页面
    if (req.method === 'GET' && route === '/') {
      sendPage(res, INDEX_HTML_REL)
      return
    }
    if (req.method === 'GET' && (route === '/control' || route === '/index.html')) {
      sendPage(res, CONTROL_HTML_REL)
      return
    }

    // 文件列表
    if (req.method === 'GET' && route === '/api/files') {
      const dir = uploadDir()
      sendJson(res, 200, { dir, files: listUploadFiles(dir) })
      return
    }

    // 上传：POST /api/upload?name=<encodeURIComponent(文件名)>，body 为文件原始字节（流式落盘）
    if (req.method === 'POST' && route === '/api/upload') {
      const rawName = url.searchParams.get('name') ?? ''
      let name = ''
      try {
        name = decodeURIComponent(rawName)
      } catch {
        sendJson(res, 400, { error: '文件名编码错误' })
        return
      }
      if (!safeFileName(name)) {
        sendJson(res, 400, { error: '非法文件名' })
        return
      }
      const dir = uploadDir()
      const dest = path.join(dir, name)
      const out = createWriteStream(dest)
      let bytes = 0
      req.on('data', (chunk: Buffer) => { bytes += chunk.length })
      req.pipe(out)
      out.on('finish', () => sendJson(res, 200, { ok: true, name, bytes }))
      out.on('error', (e) => {
        try { res.writeHead(500, { 'Connection': 'close' }); res.end(JSON.stringify({ error: e.message })) } catch { /* ignore */ }
      })
      return
    }

    // 在软件内打开：POST /api/open?name=<文件名>
    if (req.method === 'POST' && route === '/api/open') {
      const rawName = url.searchParams.get('name') ?? ''
      let name = ''
      try {
        name = decodeURIComponent(rawName)
      } catch {
        sendJson(res, 400, { error: '文件名编码错误' })
        return
      }
      if (!safeFileName(name)) {
        sendJson(res, 400, { error: '非法文件名' })
        return
      }
      const p = path.join(uploadDir(), name)
      if (!existsSync(p)) {
        sendJson(res, 404, { error: '文件不存在' })
        return
      }
      if (!remoteOpenHandler) {
        sendJson(res, 500, { error: '软件未就绪' })
        return
      }
      remoteOpenHandler(p)
        .then((ok) => sendJson(res, ok ? 200 : 500, ok ? { ok: true } : { error: '打开失败（仅支持 .pptx 文件）' }))
        .catch((e) => sendJson(res, 500, { error: (e as Error)?.message ?? '打开失败' }))
      return
    }

    // 用系统默认程序打开（非 pptx 也支持）：POST /api/open-external?name=<文件名>
    if (req.method === 'POST' && route === '/api/open-external') {
      const rawName = url.searchParams.get('name') ?? ''
      let name = ''
      try {
        name = decodeURIComponent(rawName)
      } catch {
        sendJson(res, 400, { error: '文件名编码错误' })
        return
      }
      if (!safeFileName(name)) {
        sendJson(res, 400, { error: '非法文件名' })
        return
      }
      const p = path.join(uploadDir(), name)
      if (!existsSync(p)) {
        sendJson(res, 404, { error: '文件不存在' })
        return
      }
      void shell.openPath(p).then((err) => {
        if (err) sendJson(res, 500, { error: err })
        else sendJson(res, 200, { ok: true })
      })
      return
    }

    // 删除远程文件（无需确认）：POST /api/delete?name=<文件名>
    if (req.method === 'POST' && route === '/api/delete') {
      const rawName = url.searchParams.get('name') ?? ''
      let name = ''
      try {
        name = decodeURIComponent(rawName)
      } catch {
        sendJson(res, 400, { error: '文件名编码错误' })
        return
      }
      if (!safeFileName(name)) {
        sendJson(res, 400, { error: '非法文件名' })
        return
      }
      const p = path.join(uploadDir(), name)
      if (!existsSync(p)) {
        sendJson(res, 404, { error: '文件不存在' })
        return
      }
      try {
        unlinkSync(p)
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 500, { error: (e as Error)?.message ?? '删除失败' })
      }
      return
    }

    res.writeHead(404, { 'Connection': 'close' })
    res.end('Not found')
  })

  // 绑定 0.0.0.0：监听所有网卡，手机走局域网才能连上（仅绑 127.0.0.1 则手机不可达）。
  let port = DEFAULT_PORT
  for (let attempt = 0; attempt <= 20; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => resolve())
      })
      break
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EADDRINUSE' && attempt < 20) {
        port++
        continue
      }
      throw err
    }
  }

  const wssServer = new WebSocketServer({ server })
  wssServer.on('connection', (socket: WebSocket) => {
    wsClients.add(socket)
    socket.on('close', () => wsClients.delete(socket))
    socket.on('error', () => wsClients.delete(socket))
    socket.on('message', (data) => {
      let msg: { action?: string; text?: string; name?: string; dx?: number; dy?: number; button?: string; delta?: number; way?: number; engine?: number }
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!msg || typeof msg.action !== 'string') return
      const a = msg.action
      // 收到放映/翻页等演示控制指令时，先唤起主窗口（防最小化后看不到放映、且按键误注入其它窗口）。
      // 信息呼叫(infoCall)除外：浮窗独立置顶出现，不弹出最小化的主窗口。
      if (a === 'start' || a === 'prev' || a === 'next' || a === 'exit') {
        focusSlidesWindow()
      }
      if (a === 'type') {
        if (typeof msg.text === 'string' && msg.text.length) insertText(msg.text)
        return
      }
      const vk = VK_FOR_ACTION[a]
      if (vk !== undefined) {
        tapKey(vk)
        return
      }
      // 鼠标按键标志：0x0002=左，0x0008=右（与 C# 各方式的入参一致）
      const btnFlag = msg.button === 'right' ? 0x0008 : 0x0002
      switch (a) {
        case 'mousemove':
          mouseMove(Number(msg.dx) || 0, Number(msg.dy) || 0)
          break
        case 'click':
          clickMouse(btnFlag)
          break
        case 'down':
          pressMouse(btnFlag)
          break
        case 'up':
          releaseMouse(btnFlag)
          break
        case 'wheel':
          wheel(Number(msg.delta) || 0)
          break
        // 随机点名：抽签 + 顶部浮窗 + 电脑播放，并回传给手机显示被点到的名字
        case 'rollcall': {
          try {
            const r = rollCallPick()
            if (r.name) broadcast({ type: 'rollcall', name: r.name })
          } catch {
            /* ignore */
          }
          break
        }
        // 拉取常用语列表（常用语.txt，每行一语，供遥控页下拉填充）
        case 'infophrases': {
          try {
            socket.send(JSON.stringify({ type: 'infophrases', phrases: loadInfoPhrases() }))
          } catch {
            /* ignore */
          }
          break
        }
        // 拉取学生名单（names.dll，每次临时读取，用户改了名单刷新即可生效）
        case 'names': {
          try {
            socket.send(JSON.stringify({ type: 'names', names: getRollCallNames() }))
          } catch {
            /* ignore */
          }
          break
        }
        // 直接点名：点某个具体学生（手机名单按钮触发）
        case 'callname': {
          try {
            const r = rollCallName(String(msg.name ?? ''))
            if (r.name) broadcast({ type: 'rollcall', name: r.name })
          } catch {
            /* ignore */
          }
          break
        }
        // 信息呼叫：在电脑屏幕置顶显示文字（持续 + 关闭按钮），有同名预录 mp3 则播放一次
        case 'infocall': {
          try {
            infoCallText(String(msg.text ?? ''))
          } catch {
            /* ignore */
          }
          break
        }
        // 关闭当前信息呼叫浮窗（手机端也可关闭）
        case 'infocallclose': {
          try {
            closeInfoCallWindow()
          } catch {
            /* ignore */
          }
          break
        }
        // 切换点击方式（1-4）
        case 'way': {
          const w = Number(msg.way)
          if (w >= 1 && w <= 4) clickWay = w
          break
        }
        // 切换注入引擎（1-3）：切换后重启 worker，下次点击生效
        case 'engine': {
          const e = Number(msg.engine)
          if (e >= 1 && e <= 3 && e !== engine) {
            engine = e
            killWorker()
          }
          break
        }
      }
    })
  })

  httpServer = server
  wss = wssServer
  activePort = port

  ensureFirewallRule()

  return buildInfo(port)
}

async function buildInfo(port: number): Promise<RemoteControlInfo> {
  const ips = lanIps()
  const localUrl = `http://localhost:${port}`
  const entries: { url: string; qr: string }[] = []
  for (const ip of ips) {
    const url = `http://${ip}:${port}`
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 320 })
    entries.push({ url, qr })
  }
  const lanUrl = entries[0]?.url ?? localUrl
  const qr = entries[0]?.qr ?? ''
  const lanUrls = entries.map((e) => e.url)
  return { entries, lanUrl, lanUrls, localUrl, port, qr }
}

function stopRemoteControl(): void {
  wsClients.clear()
  if (wss) {
    try {
      wss.close()
    } catch {
      /* ignore */
    }
    wss = null
  }
  if (httpServer) {
    try {
      httpServer.close()
    } catch {
      /* ignore */
    }
    httpServer = null
  }
  if (psWorker) {
    try {
      psWorker.kill()
    } catch {
      /* ignore */
    }
    psWorker = null
  }
  activePort = 0
}

/** 注册远程控制相关的 IPC 处理（供渲染进程开关服务）。 */
export function registerRemoteControlIpc(): void {
  ipcMain.handle('slides:remote-control-start', () => startRemoteControl())
  ipcMain.handle('slides:remote-control-stop', () => {
    stopRemoteControl()
  })
  // ── 放映导航“显示桌面”（Win+D，便于演示中切换程序）──
  ipcMain.handle('slides:show-desktop', () => {
    showDesktop()
    return true
  })
  // ── 防盗版：手机号验证 + 机器绑定本地记录 ──
  ipcMain.handle('slides:license-check', () => readLicense() !== null)
  ipcMain.handle('slides:license-open-verify', async () => {
    await shell.openExternal('https://www.52zwbc.com/liteppt/index.php')
  })
}

/**
 * 处理来自验证网页的回跳协议：
 *   liteppt://verified?phone=..&ts=..&sig=..  -> 校验 HMAC 签名，通过则写入机器绑定本地记录
 *   liteppt://denied                          -> 通知渲染层“验证不通过”（不会进入文件管理页的前提由网页侧保证）
 * 签名校验失败一律视为 denied，不会写入记录。
 */
export function handleLicenseProtocol(rawUrl: string): void {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'liteppt:') return
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (u.host === 'verified') {
      const phone = u.searchParams.get('phone') ?? ''
      const ts = u.searchParams.get('ts') ?? ''
      const sig = u.searchParams.get('sig') ?? ''
      if (verifyCallback(phone, ts, sig)) {
        writeLicense(phone)
        win?.webContents.send('slides:license-event', 'granted')
      } else {
        win?.webContents.send('slides:license-event', 'denied')
      }
    } else if (u.host === 'denied') {
      win?.webContents.send('slides:license-event', 'denied')
    }
  } catch {
    /* 非法 URL，忽略 */
  }
}
