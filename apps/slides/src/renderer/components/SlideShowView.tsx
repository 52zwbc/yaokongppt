/**
 * Slide show — the full-screen playback view.
 *
 * - A black show layer covering the whole window, attempting system full screen (restored on exit)
 * - The playback sequence skips hidden slides (starting from a hidden slide still plays it)
 * - Moving forward plays the target page's transition effect (CSS approximations of fade/push/wipe/split/circle/random)
 * - In-page shape animations (Animations tab): moving forward plays animations step by step, turning the page only when done;
 *   going back/jumping shows the all-animations-finished state
 * - →/space/enter/PgDn/click next step/page; ←/PgUp/right-click previous page; Home/End first/last page;
 *   Esc exits; advancing past the last page shows the "end of show" black screen
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RenderNode, RenderSlide, ShapeRenderNode } from '@genoffice/pptx-render'
import type { AnimationItem, LinkTargetOp, ShapeKey, TransitionKind } from '../../shared/ipc'
import { AnimatedSlideStage, useAnimPlayer } from './AnimatedSlide'
import { useI18n } from '../i18n/locale'
import { MorphStage } from './MorphStage'
import { InkLayer, type InkStroke } from './ShowInk'
import {
  computePlayOrder,
  finishRehearse,
  formatClock,
  startRehearse,
  switchRehearsePage,
  type RehearseTiming,
} from '../slideshow-utils'
import { liftShowCurtain } from '../show-actions'

const ANIMATED = [
  'fade',
  'push',
  'wipe',
  'split',
  'circle',
  'cover',
  'pull',
  'dissolve',
  'zoom',
] as const

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

export function SlideShowView({
  slides,
  images,
  startAt,
  onExit,
  customOrder,
  rehearseMode,
  onRehearseDone,
}: {
  slides: RenderSlide[]
  images: Map<string, HTMLImageElement>
  /** Start page (original index) */
  startAt: number
  /** Exit the show; lastIndex is the original index of the page dwelt on (for locating back in the edit view) */
  onExit: (lastIndex: number) => void
  /** Custom show: a specified playback sequence (original indexes), replacing the default full order when non-empty */
  customOrder?: number[]
  /** Rehearsal timing mode: shows a timer bar at the top and records each page's dwell time */
  rehearseMode?: boolean
  /** Rehearsal-end callback (called before onExit on exit); perPageSec is by original page index, unvisited pages are 0 */
  onRehearseDone?: (perPageSec: number[]) => void
}) {
  const { t } = useI18n()
  // Playback sequence (original indexes): hidden pages skipped (except the start page); custom shows use the given order
  const order = useMemo(
    () => computePlayOrder(slides, startAt, customOrder),
    [slides, startAt, customOrder],
  )
  const [pos, setPos] = useState(() => Math.max(0, order.indexOf(startAt)))
  const [ended, setEnded] = useState(false)
  /** Current transition animation: kind + replay nonce (key change re-triggers the CSS animation) */
  const [anim, setAnim] = useState<{ kind: TransitionKind; nonce: number }>({
    kind: 'none',
    nonce: 0,
  })
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  /** False until the window covers the screen: the black root paints alone first so
   *  the window snap / tab-strip bleed relayouts stay invisible (no windowed flash) */
  const [covered, setCovered] = useState(false)
  /** Per-page transition effects (prefetched once when the show starts, zero IPC on page turns) */
  const transRef = useRef<TransitionKind[]>([])
  /** Per-page animation lists (also prefetched once) */
  const [allAnims, setAllAnims] = useState<AnimationItem[][] | null>(null)
  /** Per-page element Morph pairing keys (also prefetched once) */
  const keysRef = useRef<ShapeKey[][]>([])
  /** Per-page element hyperlinks (also prefetched once): sourceId → target; clicks hit-test against these */
  const linksRef = useRef<Array<Map<string, LinkTargetOp>>>([])
  /** Per-page run hyperlinks: "sourceId:para:run" → target; hit-tested against layout glyph runs */
  const runLinksRef = useRef<Array<Map<string, LinkTargetOp>>>([])
  /** Morph tween in progress: previous/target page original indexes + replay nonce */
  const [morph, setMorph] = useState<{ fromIdx: number; toIdx: number; nonce: number } | null>(null)
  /** How the current page was entered: forward = initial state playing step by step, others = all-finished state */
  const navModeRef = useRef<'fresh' | 'all'>('fresh')

  // ── Show ink (pen annotation) ───────────────────────────────────────────
  // Per-page strokes keyed by original slide index; they survive a page turn
  // (hidden until you return to that page) and the pen mode exits on turn.
  const PEN_COLORS = ['#e53935', '#43a047', '#1e88e5', '#fdd835', '#ffffff', '#212121']
  const [penOn, setPenOn] = useState(false)
  const [penColor, setPenColor] = useState('#e53935') // default red
  /** 画笔模式：'fg'=前景（在幻灯片上标注）；'bg'=背景（点颜色把整屏设为纯色，白板/黑板）。默认前景。 */
  const [penMode, setPenMode] = useState<'fg' | 'bg'>('fg')
  /** 白板背景色（null=无背景，显示幻灯片内容）。翻页/返回时清空。 */
  const [bgColor, setBgColor] = useState<string | null>(null)
  const [curStrokes, setCurStrokes] = useState<InkStroke[]>([])
  const curStrokesRef = useRef<InkStroke[]>([])
  const strokesByPageRef = useRef<Record<number, InkStroke[]>>({})
  const drawingRef = useRef(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const lastIdxRef = useRef<number>(order[pos] ?? -1)
  useEffect(() => {
    curStrokesRef.current = curStrokes
  }, [curStrokes])
  // On page turn: stash the leaving page's strokes, load the entering page's,
  // and drop out of pen mode (strokes reappear when you come back).
  // 背景色与前景/背景模式也一并清空：翻页后背景和笔触都消失；返回时只恢复笔触、不恢复背景。
  useEffect(() => {
    const leaving = lastIdxRef.current
    if (leaving >= 0) strokesByPageRef.current[leaving] = curStrokesRef.current
    const entering = order[pos] ?? -1
    setCurStrokes(entering >= 0 ? strokesByPageRef.current[entering] ?? [] : [])
    setPenOn(false)
    setPenMode('fg')
    setBgColor(null)
    lastIdxRef.current = entering
  }, [pos]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    void Promise.all(slides.map((_, i) => window.slidesApi.getTransition(i))).then((kinds) => {
      if (!cancelled) transRef.current = kinds
    })
    void Promise.all(slides.map((_, i) => window.slidesApi.getAnimations(i))).then((lists) => {
      if (!cancelled) setAllAnims(lists)
    })
    void Promise.all(slides.map((_, i) => window.slidesApi.getShapeKeys(i))).then((keys) => {
      if (!cancelled) keysRef.current = keys
    })
    void Promise.all(slides.map((_, i) => window.slidesApi.getSlideLinks(i))).then((lists) => {
      if (!cancelled)
        linksRef.current = lists.map(
          (list) => new Map(list.map(({ sourceId, target }) => [sourceId, target])),
        )
    })
    void Promise.all(slides.map((_, i) => window.slidesApi.getRunLinks(i))).then((lists) => {
      if (!cancelled)
        runLinksRef.current = lists.map(
          (list) =>
            new Map(
              list.map((l) => [`${l.sourceId}:${l.paraIndex}:${l.runIndex}`, l.target] as const),
            ),
        )
    })
    return () => {
      cancelled = true
    }
  }, [slides])

  const slide = slides[order[pos]!]
  const player = useAnimPlayer(slide?.heightPx ?? 540, slide?.widthPx ?? 960)

  // ── Rehearsal timing: start timing the first page on entry; accumulate the previous page's dwell on turn; redraw the timer bar every 500ms ──
  const rehearseRef = useRef<RehearseTiming | null>(null)
  const [, setRehearseTick] = useState(0)
  useEffect(() => {
    if (!rehearseMode) return
    rehearseRef.current = startRehearse(slides.length, order[pos] ?? startAt, Date.now())
    const h = window.setInterval(() => setRehearseTick((n) => n + 1), 500)
    return () => window.clearInterval(h)
    // Initialize only once on entering the show (slides/order don't change during the show)
  }, [rehearseMode]) // eslint-disable-line react-hooks/exhaustive-deps
  const curIdx = order[pos]
  useEffect(() => {
    const t = rehearseRef.current
    if (t && curIdx != null && curIdx !== t.currentIndex) {
      rehearseRef.current = switchRehearsePage(t, curIdx, Date.now())
    }
  }, [curIdx])

  // Load the page's animations when the page changes/prefetch completes (forward = initial state, back/jump = finished state)
  useEffect(() => {
    player.load(allAnims?.[order[pos]!] ?? [], navModeRef.current)
  }, [allAnims, pos, order, player.load]) // eslint-disable-line react-hooks/exhaustive-deps

  const exitRef = useRef(() => {})
  exitRef.current = () => {
    // Rehearsal mode: report each page's dwell seconds before exit (ref nulled to prevent duplicate fullscreenchange triggers)
    const t = rehearseRef.current
    if (rehearseMode && onRehearseDone && t) {
      rehearseRef.current = null
      onRehearseDone(finishRehearse(t, Date.now()))
    }
    onExit(order[Math.min(pos, order.length - 1)] ?? startAt)
  }

  // System full screen: requested on entering the show; exiting/user leaving full screen ends the show.
  // Entry is detected from the fullscreenchange event, not the requestFullscreen promise: inside the
  // shell's WebContentsView the promise can stay pending/reject even though fullscreen engaged, which
  // left the show mounted after Esc (fullscreen gone, show still covering the window).
  useEffect(() => {
    // already-fullscreen mounts (presenter view handing off to the normal show
    // keeps fullscreen) never get a fullscreenchange, so seed from current state
    let entered = !!document.fullscreenElement
    let exitTimer = 0
    let alive = true
    // The IPC covers the screen in one main-side call (tab-strip bleed + macOS
    // simpleFullScreen snap — no Space animation), all hidden behind this
    // component's black root; the slide is revealed only once the viewport really
    // reached screen size (500ms cap for stale preloads / unfullscreenable windows),
    // so it never lays out at the pre-snap size and re-jumps. On macOS HTML
    // fullscreen is skipped — it would only re-trigger the animated native
    // fullscreen. Stale preloads lack the API and keep the old animated behavior.
    const snapped = window.slidesApi.setShowFullScreen?.(true) ?? Promise.resolve()
    void snapped
      .catch(() => {})
      .then(() => {
        if (!IS_MAC) void document.documentElement.requestFullscreen?.().catch(() => {})
        // Covered = the viewport spans the WHOLE screen, width and height (the
        // bleed-only intermediate differs in height, a full-width window in
        // height too — no partial state passes both). window.screen tracks the
        // display the window is on, so narrower secondary displays settle at
        // their own size. Deadline covers stale preloads that never snap.
        const deadline = performance.now() + 500
        const reveal = () => {
          if (!alive) return
          const w = window.innerWidth
          const h = window.innerHeight
          const settled = w >= screen.width && h >= screen.height
          if (!settled && performance.now() < deadline) {
            requestAnimationFrame(reveal)
            return
          }
          setSize({ w, h })
          setCovered(true)
        }
        requestAnimationFrame(reveal)
      })
    const onFsChange = () => {
      if (document.fullscreenElement) {
        entered = true
        window.clearTimeout(exitTimer)
        return
      }
      if (!entered) return
      // Grace window before ending the show: a strict-mode remount briefly drops
      // fullscreen (previous cleanup's exitFullscreen) and re-enters right away —
      // only a loss that sticks means the user actually left fullscreen.
      window.clearTimeout(exitTimer)
      exitTimer = window.setTimeout(() => {
        if (!document.fullscreenElement) exitRef.current()
      }, 150)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      alive = false
      window.clearTimeout(exitTimer)
      document.removeEventListener('fullscreenchange', onFsChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      void window.slidesApi.setShowFullScreen?.(false)
      liftShowCurtain()
    }
  }, [])

  // The click-time curtain (dropped in show-actions before this component mounted)
  // is only needed until the show reveals — its own black root covers from there on
  useEffect(() => {
    if (covered) liftShowCurtain()
  }, [covered])

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const goTo = useCallback(
    (nextPos: number, animate: boolean) => {
      const target = order[nextPos]
      if (target == null) return
      navModeRef.current = animate ? 'fresh' : 'all'
      const current = order[pos]
      let kind: TransitionKind = 'none'
      if (animate) {
        kind = transRef.current[target] ?? 'none'
        if (kind === 'random') kind = ANIMATED[Math.floor(Math.random() * ANIMATED.length)]!
      }
      if (kind === 'morph' && current != null && current !== target) {
        // Morph: skips the CSS page transition; MorphStage tweens elements from the previous page to the target
        setMorph((m) => ({ fromIdx: current, toIdx: target, nonce: (m?.nonce ?? 0) + 1 }))
        setAnim((a) => ({ kind: 'none', nonce: a.nonce + 1 }))
      } else {
        // Morphs that can't tween (start page/same page) degrade to fade-in
        if (kind === 'morph') kind = 'fade'
        setMorph(null)
        setAnim((a) => ({ kind, nonce: a.nonce + 1 }))
      }
      setPos(nextPos)
    },
    [order, pos],
  )

  const next = useCallback(() => {
    if (ended) {
      exitRef.current()
      return
    }
    // Advance in-page animations first; turn the page only when this page's animations are done
    if (player.advance()) return
    if (pos >= order.length - 1) setEnded(true)
    else goTo(pos + 1, true)
  }, [ended, pos, order.length, goTo, player.advance]) // eslint-disable-line react-hooks/exhaustive-deps

  const prev = useCallback(() => {
    if (ended) {
      setEnded(false)
      return
    }
    if (pos > 0) goTo(pos - 1, false)
  }, [ended, pos, goTo])

  // Element hyperlinks during the show (PowerPoint behavior): a click on a linked element follows
  // the link instead of advancing — slide links (Zoom/jump) go to that page, URLs open in the browser
  const followLink = useCallback(
    (target: LinkTargetOp) => {
      if (target.kind === 'slide') {
        const p = order.indexOf(target.slideIndex)
        // Hidden pages aren't in the play order; ignore jumps to them (matching the skip semantics)
        if (p >= 0) {
          setEnded(false)
          goTo(p, true)
        }
        return
      }
      // Electron routes window.open to the system browser (setWindowOpenHandler denies in-app windows)
      window.open(target.kind === 'url' ? target.url : '', '_blank', 'noreferrer')
    },
    [order, goTo],
  )
  /** Click/hover position → slide-model px → topmost linked element's target (null = no link there) */
  const linkAt = useCallback(
    (e: React.MouseEvent<HTMLElement>): LinkTargetOp | null => {
      const cur = order[pos]
      const links = (cur != null ? linksRef.current[cur] : undefined) ?? new Map()
      const runLinks = (cur != null ? runLinksRef.current[cur] : undefined) ?? new Map()
      if ((!links.size && !runLinks.size) || !slide) return null
      const rect = e.currentTarget.getBoundingClientRect()
      const kx = slide.widthPx / rect.width
      return hitLink(
        slide.nodes,
        (e.clientX - rect.left) * kx,
        (e.clientY - rect.top) * kx,
        links,
        runLinks,
      )
    },
    [order, pos, slide],
  )

  // ── Pen drawing (normalized 0..1 coords over the slide frame) ──────────────
  const normPoint = useCallback((e: React.PointerEvent): { x: number; y: number } | null => {
    const r = frameRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return null
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }, [])

  const onInkDown = useCallback(
    (e: React.PointerEvent) => {
      if (!penOn) return
      const p = normPoint(e)
      if (!p) return
      e.currentTarget.setPointerCapture(e.pointerId)
      drawingRef.current = true
      setCurStrokes((ss) => [...ss, { color: penColor, points: [p.x, p.y] }])
    },
    [penOn, penColor, normPoint],
  )

  const onInkMove = useCallback(
    (e: React.PointerEvent) => {
      if (!penOn || !drawingRef.current) return
      const p = normPoint(e)
      if (!p) return
      setCurStrokes((ss) => {
        const last = ss[ss.length - 1]
        if (!last) return ss
        return [...ss.slice(0, -1), { ...last, points: [...last.points, p.x, p.y] }]
      })
    },
    [penOn, normPoint],
  )

  const onInkUp = useCallback(() => {
    drawingRef.current = false
  }, [])

  const undoInk = useCallback(() => setCurStrokes((ss) => ss.slice(0, -1)), [])
  const clearInk = useCallback(() => setCurStrokes([]), [])
  /** 点颜色：前景模式设画笔色；背景模式把整屏设为该纯色（白板/黑板）。 */
  const onColorPick = useCallback(
    (c: string) => {
      if (penMode === 'bg') setBgColor(c)
      else setPenColor(c)
    },
    [penMode],
  )

  // Keyboard navigation (capture beats the editor's generic shortcuts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        exitRef.current()
      } else if (
        e.key === 'ArrowRight' ||
        e.key === 'ArrowDown' ||
        e.key === ' ' ||
        e.key === 'Enter' ||
        e.key === 'PageDown'
      ) {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault()
        prev()
      } else if (e.key === 'Home') {
        e.preventDefault()
        setEnded(false)
        goTo(0, false)
      } else if (e.key === 'End') {
        e.preventDefault()
        setEnded(false)
        goTo(order.length - 1, false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [next, prev, goTo, order.length])

  if (!slide) return null
  const fitW = Math.round(Math.min(size.w, (size.h * slide.widthPx) / slide.heightPx))
  const fitH = Math.round((fitW * slide.heightPx) / slide.widthPx)
  // Rehearsal timer bar values: current page dwell (including earlier revisit accumulation) + total elapsed
  const rehearse = rehearseRef.current
  const sinceEntered = rehearse ? Date.now() - rehearse.enteredAt : 0
  const rehearseCurMs = rehearse
    ? (rehearse.perPageMs[rehearse.currentIndex] ?? 0) + sinceEntered
    : 0
  const rehearseTotalMs = rehearse
    ? rehearse.perPageMs.reduce((a, b) => a + b, 0) + sinceEntered
    : 0

  return (
    <div
      className="slideshow"
      onContextMenu={(e) => {
        e.preventDefault()
        prev()
      }}
    >
      {!covered ? null : (
        <>
          {/* 白板/黑板背景层：整屏纯色，盖在幻灯片之下、工具栏与笔触之上之下。背景色翻页/返回时清空。 */}
          {bgColor && <div className="ss-whiteboard" style={{ background: bgColor }} />}
          {ended ? (
            <div className="ss-end" onClick={() => exitRef.current()}>
              {t('paneShowEndedClick')}
            </div>
          ) : morph && slides[morph.fromIdx] && slides[morph.toIdx] ? (
            <div key={`morph-${morph.nonce}`} className="ss-frame">
              <MorphStage
                from={slides[morph.fromIdx]!}
                to={slides[morph.toIdx]!}
                fromKeys={keysRef.current[morph.fromIdx] ?? []}
                toKeys={keysRef.current[morph.toIdx] ?? []}
                images={images}
                width={fitW}
                onDone={() => setMorph(null)}
              />
            </div>
          ) : (
            <div
              key={anim.nonce}
              className={`ss-frame${anim.kind !== 'none' ? ` ss-anim-${anim.kind}` : ''}`}
            >
              <div
                ref={frameRef}
                style={{ position: 'relative', width: fitW, height: fitH, margin: '0 auto' }}
                onClick={(e) => {
                  if (penOn) return
                  const target = linkAt(e)
                  if (!target) return // No link here: nothing advances (nav buttons only)
                  e.stopPropagation()
                  followLink(target)
                }}
                onMouseMove={(e) => {
                  if (penOn) return
                  e.currentTarget.style.cursor = linkAt(e) ? 'pointer' : ''
                }}
              >
                {/* 白板模式下隐藏幻灯片内容，只留纯色背景 + 笔触；返回普通模式再显示 */}
                {!bgColor && (
                  <AnimatedSlideStage
                    slide={slide}
                    images={images}
                    width={fitW}
                    states={player.states}
                  />
                )}
                {!bgColor && (
                  <ShowMediaLayer slide={slide} slideIndex={order[pos]!} width={fitW} />
                )}
                <InkLayer strokes={curStrokes} laser={null} width={fitW} height={fitH} />
                {penOn && (
                  <div
                    className="ss-ink-capture"
                    onPointerDown={onInkDown}
                    onPointerMove={onInkMove}
                    onPointerUp={onInkUp}
                    onPointerLeave={onInkUp}
                  />
                )}
              </div>
            </div>
          )}
          {rehearseMode && rehearse && (
            <div className="ss-rehearse" data-tip={t('paneShowRehearseTip')}>
              <span className="ss-rehearse-cur">⏱ {formatClock(rehearseCurMs)}</span>
              <span className="ss-rehearse-total">
                {t('paneShowRehearseTotal', { time: formatClock(rehearseTotalMs) })}
              </span>
            </div>
          )}
          <div className="ss-counter">
            {pos + 1} / {order.length}
          </div>
          <div className="ss-toolbar">
            {penOn && (
              <>
                {/* 前景/背景切换：默认前景（在幻灯片上标注）；切到背景后点颜色把整屏设为纯色 */}
                <button
                  type="button"
                  className={`ss-tool ss-penmode${penMode === 'bg' ? ' ss-mode-bg' : ''}`}
                  onClick={() => setPenMode((m) => (m === 'fg' ? 'bg' : 'fg'))}
                  data-tip={penMode === 'fg' ? '当前：前景（点颜色设画笔色）' : '当前：背景（点颜色设整屏纯色）'}
                  aria-label="前景/背景切换"
                >
                  {penMode === 'fg' ? '前景' : '背景'}
                </button>
                {PEN_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`ss-color${penMode === 'bg' ? ' ss-bg-on' : ''}${penMode !== 'bg' && penColor === c ? ' ss-color-on' : ''}`}
                    style={{ background: c }}
                    onClick={() => onColorPick(c)}
                    data-tip={penMode === 'bg' ? '把整屏背景设为该颜色' : '选择画笔颜色'}
                    aria-label={penMode === 'bg' ? '设置背景颜色' : '选择画笔颜色'}
                  />
                ))}
                <button
                  type="button"
                  className="ss-tool"
                  onClick={undoInk}
                  data-tip="撤销上一笔"
                  aria-label="撤销上一笔"
                >
                  ↶
                </button>
                <button
                  type="button"
                  className="ss-tool"
                  onClick={clearInk}
                  data-tip="清空白页笔触"
                  aria-label="清空白页笔触"
                >
                  ⌫
                </button>
              </>
            )}
            <button
              type="button"
              className="ss-tool"
              onClick={prev}
              data-tip="上一页"
              aria-label="上一页"
            >
              ‹
            </button>
            <button
              type="button"
              className="ss-tool"
              onClick={next}
              data-tip="下一页"
              aria-label="下一页"
            >
              ›
            </button>
            <button
              type="button"
              className={`ss-tool ss-rollcall`}
              onClick={() => window.slidesApi.rollCallPick()}
              data-tip="随机点名"
              aria-label="随机点名"
            >
              <svg viewBox="0 0 24 24" width="28" height="28" fill="#fff" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7v1H4z" />
              </svg>
            </button>
            <button
              type="button"
              className={`ss-tool${penOn ? ' ss-pen-on' : ''}`}
              onClick={() => setPenOn((v) => !v)}
              data-tip="画笔标注"
              aria-label="画笔标注"
            >
              ✎
            </button>
            <button
              type="button"
              className="ss-tool ss-exit"
              onClick={() => exitRef.current()}
              data-tip="退出放映"
              aria-label="退出放映"
            >
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Topmost linked element at a point (slide-model px). Scans nodes back-to-front (z-order),
 * descends into groups (children boxes are group-local); unlinked overlapping nodes don't block
 * links underneath (lenient, matches the show's forgiving click behavior).
 */
function hitLink(
  nodes: RenderNode[],
  x: number,
  y: number,
  links: Map<string, LinkTargetOp>,
  runLinks: Map<string, LinkTargetOp>,
): LinkTargetOp | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!
    const { box } = n
    if (x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h) continue
    if (n.type === 'group') {
      const inner = hitLink(n.children, x - box.x, y - box.y, links, runLinks)
      if (inner) return inner
    }
    // Run-level link on the glyph under the pointer beats the whole-element link (more specific)
    const text = (n as ShapeRenderNode).text
    if (text && runLinks.size) {
      let para = -1
      for (const ln of text.lines) {
        if (ln.paraStart !== false) para++
        const ly = box.y + text.insets.t + ln.top
        if (y < ly || y > ly + ln.height) continue
        for (const r of ln.runs) {
          if (r.srcRunIdx == null) continue
          const rx = box.x + text.insets.l + r.x
          if (x < rx || x > rx + r.widthPx) continue
          const target = runLinks.get(`${n.sourceId}:${para}:${r.srcRunIdx}`)
          if (target) return target
        }
      }
    }
    const target = links.get(n.sourceId)
    if (target) return target
  }
  return null
}

/**
 * Audio/video layer during the show: DOM players stacked over video/audio nodes (click to
 * play/pause, auto-stop on page turn). In the editor media only has poster frames; a show must
 * be able to play, or decks with video are crippled.
 */
function ShowMediaLayer({
  slide,
  slideIndex,
  width,
}: {
  slide: RenderSlide
  slideIndex: number
  width: number
}) {
  const k = width / slide.widthPx
  const nodes = slide.nodes.filter(
    (n): n is import('@genoffice/pptx-render').PictureRenderNode =>
      n.type === 'picture' && !!(n as import('@genoffice/pptx-render').PictureRenderNode).media,
  )
  const [urls, setUrls] = useState<Record<string, { kind: 'video' | 'audio'; dataUrl: string }>>({})
  const [playing, setPlaying] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let cancelled = false
    setUrls({})
    setPlaying({})
    for (const n of nodes) {
      void window.slidesApi.getMediaData(slideIndex, n.sourceId).then((d) => {
        if (!cancelled && d) setUrls((u) => ({ ...u, [n.sourceId]: d }))
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideIndex])
  if (!nodes.length) return null
  return (
    <>
      {nodes.map((n) => {
        const media = urls[n.sourceId]
        if (!media) return null
        const style: React.CSSProperties = {
          position: 'absolute',
          left: n.box.x * k,
          top: n.box.y * k,
          width: n.box.w * k,
          height: n.box.h * k,
          cursor: 'pointer',
        }
        const isPlaying = !!playing[n.sourceId]
        const toggle = (el: HTMLMediaElement | null) => {
          if (!el) return
          if (el.paused) void el.play()
          else el.pause()
        }
        if (media.kind === 'video') {
          return (
            <video
              key={n.sourceId}
              src={media.dataUrl}
              style={style}
              playsInline
              onClick={(e) => {
                e.stopPropagation()
                toggle(e.currentTarget)
              }}
              onPlay={() => setPlaying((p) => ({ ...p, [n.sourceId]: true }))}
              onPause={() => setPlaying((p) => ({ ...p, [n.sourceId]: false }))}
            />
          )
        }
        // Audio: the poster frame is drawn by the canvas; overlay a transparent click layer + play badge
        return (
          <div
            key={n.sourceId}
            style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={(e) => {
              e.stopPropagation()
              toggle(document.getElementById(`ss-audio-${n.sourceId}`) as HTMLMediaElement | null)
            }}
          >
            <audio
              id={`ss-audio-${n.sourceId}`}
              src={media.dataUrl}
              onPlay={() => setPlaying((p) => ({ ...p, [n.sourceId]: true }))}
              onPause={() => setPlaying((p) => ({ ...p, [n.sourceId]: false }))}
            />
            <span
              style={{
                fontSize: Math.min(n.box.w, n.box.h) * k * 0.4,
                lineHeight: 1,
                opacity: 0.85,
              }}
            >
              {isPlaying ? '⏸' : '▶'}
            </span>
          </div>
        )
      })}
    </>
  )
}
