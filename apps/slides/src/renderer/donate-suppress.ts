/**
 * 启动赞赏弹窗的屏蔽开关（预留）。
 *
 * 本版本（0.6.1）：弹窗每次启动都显示一次，屏蔽逻辑暂不启用。
 * 下个版本：扫码支持成功后调用 setDonateModalSuppressed(true)（例如扫码回调、
 * “不再提示”勾选），之后启动时 isDonateModalSuppressed() 为 true 即不再弹窗。
 * App.tsx 已按此契约接入：`useState(() => !isDonateModalSuppressed())`。
 */
export const DONATE_MODAL_SUPPRESS_KEY = 'ykppt.donate-modal-suppressed'

/** 下个版本启用屏蔽后：返回 true 则启动时不再显示赞赏弹窗。 */
export function isDonateModalSuppressed(): boolean {
  try {
    return localStorage.getItem(DONATE_MODAL_SUPPRESS_KEY) === '1'
  } catch {
    return false
  }
}

/** 下个版本扫码成功 / 用户勾选“不再提示”后调用，持久化屏蔽标记。 */
export function setDonateModalSuppressed(suppressed: boolean): void {
  try {
    if (suppressed) localStorage.setItem(DONATE_MODAL_SUPPRESS_KEY, '1')
    else localStorage.removeItem(DONATE_MODAL_SUPPRESS_KEY)
  } catch {
    /* 存储不可用时忽略：下次启动继续弹窗 */
  }
}
