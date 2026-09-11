/**
 * LitePPT 远程文件管理 —— PC 端本地授权记录（机器绑定，防复制绕过）
 *
 * 这是「防盗版」的后半段（前半段在你的网站 index.php）。本文件尚未被接入，
 * 需要你在渲染层「远程控制」入口调用下面导出的函数，流程如下：
 *
 *  打开远程文件管理时：
 *    const rec = readLicense()
 *    if (rec) { 直接进入文件管理 }
 *    else {
 *      用 webview 加载 https://www.52zwbc.com/liteppt/index.php
 *      webview 即将跳转到 liteppt://verified?phone=&ts=&sig=  -> 调用 verifyCallback 校验签名
 *         校验通过 -> writeLicense(phone) -> 进入文件管理
 *      webview 即将跳转到 liteppt://denied -> 显示“验证不通过”，不进入
 *      webview 加载失败（网站不可达）-> 降级：直接进入文件管理（基础功能可用）
 *    }
 *
 * 防复制原理：记录文件用「当前机器的指纹」派生的密钥做 AES-256-GCM 加密。
 *   把文件拷到别的电脑 -> 机器指纹不同 -> 解密失败 -> 视为无效 -> 重新走网站验证，无法绕过。
 *
 * 注意：SECRET 必须与网站 index.php 的 SECRET 完全一致。
 */
import { app } from 'electron'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

// ⚠️ 必须与网站 index.php 的 SECRET 完全一致，请改成你自己的长随机字符串
const SECRET = '请改成你自己的长随机字符串-例如-ZwBc-LitePPT-2026-!@#%'

// 本地记录文件放在用户数据目录（可写，不必管理员权限）
const LIC_FILE = path.join(app.getPath('userData'), '.lpt_lic')

let _fpCache: string | null = null
/** 机器指纹：Windows 优先用 MachineGuid（重装系统才变），回退到首个非内网 MAC。进程内缓存，避免重复查询与偶发不一致。 */
export function machineFingerprint(): string {
  if (_fpCache) return _fpCache
  let fp = ''
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8' }
      )
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)
      if (m && m[1]) fp = 'win:' + m[1].trim()
    } catch {
      /* 忽略，走回退 */
    }
  }
  if (!fp) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00:00') {
          fp = 'mac:' + ni.mac
          break
        }
      }
    }
  }
  if (!fp) fp = 'fallback:' + os.hostname()
  _fpCache = fp
  return fp
}

function deriveKey(fp: string): Buffer {
  return crypto.scryptSync(Buffer.from(fp, 'utf8'), Buffer.from(SECRET, 'utf8'), 32)
}

export interface LicenseRecord {
  phone: string
  ts: number
  fp: string
}

/** 读取并校验本地记录；解密失败或机器指纹不符返回 null（视为未授权）。 */
export function readLicense(): LicenseRecord | null {
  try {
    const raw = fs.readFileSync(LIC_FILE, 'utf8').trim()
    const sep = raw.indexOf(':')
    if (sep < 0) return null
    const iv = Buffer.from(raw.slice(0, sep), 'base64')
    const ct = Buffer.from(raw.slice(sep + 1), 'base64')
    const tag = ct.subarray(ct.length - 16)
    const data = ct.subarray(0, ct.length - 16)
    const key = deriveKey(machineFingerprint())
    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv)
    dec.setAuthTag(tag)
    const json = dec.update(data).toString('utf8') + dec.final().toString('utf8')
    const rec = JSON.parse(json) as LicenseRecord
    if (rec.fp !== machineFingerprint()) return null // 在其他电脑上
    return rec
  } catch {
    return null
  }
}

/** 写入本地机器绑定记录（验证通过后调用）。 */
export function writeLicense(phone: string): void {
  const rec: LicenseRecord = { phone, ts: Date.now(), fp: machineFingerprint() }
  const iv = crypto.randomBytes(12)
  const key = deriveKey(rec.fp)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(JSON.stringify(rec), 'utf8'), c.final()])
  const tag = c.getAuthTag()
  // 注意：iv 与密文必须分别 base64 再用 ':' 连接。base64 字符集不含 ':'，
  // 若把 ':' 字面字节混进待 base64 的 Buffer 再整体编码，分隔符会丢失导致读不回。
  const payload = iv.toString('base64') + ':' + Buffer.concat([enc, tag]).toString('base64')
  fs.writeFileSync(LIC_FILE, payload)
}

/** 校验网站回传的签名（HMAC），并限制 5 分钟有效，防止用户手动伪造 liteppt://verified。 */
export function verifyCallback(phone: string, ts: string, sig: string): boolean {
  const expect = crypto.createHmac('sha256', SECRET).update(phone + '|' + ts).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length) return false
  if (!crypto.timingSafeEqual(a, b)) return false
  const age = Date.now() - Number(ts) * 1000
  return age >= 0 && age < 5 * 60 * 1000
}
