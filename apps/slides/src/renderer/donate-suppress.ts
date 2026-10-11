/**
 * 启动赞赏弹窗的屏蔽开关（预留）。
 *
 * v0.6.2 起启用：弹窗新增“已扫码，不再显示”按钮，点击后调用
 * setDonateModalSuppressed(true)，之后启动时 isDonateModalSuppressed()
 * 为 true 即不再弹窗；“关闭”/右上角 × 仅关闭本次，下次仍弹。
 * App.tsx 已按此契约接入：`useState(() => !isDonateModalSuppressed())`。
 */
export const DONATE_MODAL_SUPPRESS_KEY = 'ykppt.donate-modal-suppressed'

/** 返回 true 则启动时不再显示赞赏弹窗（用户点过“已扫码，不再显示”）。 */
export function isDonateModalSuppressed(): boolean {
  try {
    return localStorage.getItem(DONATE_MODAL_SUPPRESS_KEY) === '1'
  } catch {
    return false
  }
}

/** 用户点击“已扫码，不再显示”后调用，持久化屏蔽标记。 */
export function setDonateModalSuppressed(suppressed: boolean): void {
  try {
    if (suppressed) localStorage.setItem(DONATE_MODAL_SUPPRESS_KEY, '1')
    else localStorage.removeItem(DONATE_MODAL_SUPPRESS_KEY)
  } catch {
    /* 存储不可用时忽略：下次启动继续弹窗 */
  }
}
