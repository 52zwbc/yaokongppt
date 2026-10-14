/**
 * Audio/video layer during a show: DOM players stacked over video/audio nodes.
 * In the editor media only has poster frames; a show must be able to play, or decks
 * with video are crippled. Playback is driven two ways, like PowerPoint:
 * - media animations (Play / Pause / Stop in the click sequence) arrive as `commands`
 *   from the animation player and are applied in order as the cursor reaches them;
 * - a click on the media itself toggles play/pause ("When Clicked On").
 * Everything stops when the page turns (the layer remounts per slide).
 */
import React, { useEffect, useRef, useState } from 'react'
import type { PictureRenderNode, RenderSlide } from '@genoffice/pptx-render'
import type { MediaCommand } from '../animation-play'

export function ShowMediaLayer({
  slide,
  slideIndex,
  width,
  commands,
  epoch,
  mediaBase,
  muted = false,
  interactive = true,
}: {
  slide: RenderSlide
  slideIndex: number
  width: number
  commands: MediaCommand[]
  /** Player load/seek generation: the applied cursor is re-based on mediaBase when it changes */
  epoch: number
  /** Commands the player's load/seek already counts as fired (see AnimPlayer.mediaBase) */
  mediaBase: number
  /** Presenter's own preview: plays in sync but silent (the audience window carries the sound) */
  muted?: boolean
  /** false = clicks fall through (presenter stage keeps its ink tools) */
  interactive?: boolean
}) {
  const k = width / slide.widthPx
  const nodes = slide.nodes.filter(
    (n): n is PictureRenderNode => n.type === 'picture' && !!(n as PictureRenderNode).media,
  )
  const [urls, setUrls] = useState<Record<string, { kind: 'video' | 'audio'; dataUrl: string }>>({})
  const [playing, setPlaying] = useState<Record<string, boolean>>({})
  const els = useRef(new Map<string, HTMLMediaElement>())
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

  // Apply the commands not seen yet, in order; a command whose element has not mounted
  // (media bytes still loading) blocks the tail until the URL arrives. A load/seek re-bases
  // the cursor on what the player counts as already fired (never below it, so a page landed
  // on in its played state stays silent; never above what was applied, so the audience's
  // per-cursor seeks keep firing the steps reached since). Callers key the layer per slide.
  const applied = useRef(0)
  const seenEpoch = useRef<number | null>(null)
  useEffect(() => {
    if (seenEpoch.current !== epoch) {
      seenEpoch.current = epoch
      applied.current = Math.max(Math.min(applied.current, commands.length), mediaBase)
    }
    while (applied.current < commands.length) {
      const c = commands[applied.current]!
      const el = els.current.get(c.sourceId)
      if (!el) {
        if (!nodes.some((n) => n.sourceId === c.sourceId)) {
          applied.current++
          continue
        }
        return
      }
      runMediaCommand(el, c.effect)
      applied.current++
    }
  }, [commands, epoch, mediaBase, urls, nodes])

  if (!nodes.length) return null
  const toggle = (el: HTMLMediaElement | null) => {
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }
  const ref = (id: string) => (el: HTMLMediaElement | null) => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }
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
          cursor: interactive ? 'pointer' : undefined,
          pointerEvents: interactive ? undefined : 'none',
        }
        const isPlaying = !!playing[n.sourceId]
        const onPlay = () => setPlaying((p) => ({ ...p, [n.sourceId]: true }))
        const onPause = () => setPlaying((p) => ({ ...p, [n.sourceId]: false }))
        if (media.kind === 'video') {
          return (
            <VideoPlayer
              key={n.sourceId}
              src={media.dataUrl}
              style={style}
              muted={muted}
              setRef={ref(n.sourceId)}
              onPlay={onPlay}
              onPause={onPause}
              onToggle={(el) => toggle(el)}
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
              toggle(els.current.get(n.sourceId) ?? null)
            }}
          >
            <audio
              ref={ref(n.sourceId)}
              src={media.dataUrl}
              muted={muted}
              onPlay={onPlay}
              onPause={onPause}
            />
            <span
              style={{
                fontSize: Math.min(n.box.w, n.box.h) * k * 0.4,
                lineHeight: 1,
                opacity: 0.85,
              }}
            >
              {isPlaying ? '\u23F8' : '\u25B6'}
            </span>
          </div>
        )
      })}
    </>
  )
}

/** mm:ss for the player bar (NaN/negative from unloaded metadata shows 0:00). */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Video with a web-like control bar: click (or hover) reveals play/pause,
 * seek, volume and fullscreen. Everything stops at the capture phase so the
 * show never turns the page under a control gesture; arrow keys on the
 * sliders are guarded by the views' key handlers ([data-media-controls]).
 */
function VideoPlayer({
  src,
  style,
  muted,
  setRef,
  onPlay,
  onPause,
  onToggle,
}: {
  src: string
  style: React.CSSProperties
  muted: boolean
  setRef: (el: HTMLVideoElement | null) => void
  onPlay: () => void
  onPause: () => void
  onToggle: (el: HTMLVideoElement) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [showBar, setShowBar] = useState(false)
  const [paused, setPaused] = useState(true)
  const [time, setTime] = useState(0)
  const [dur, setDur] = useState(0)
  const [vol, setVol] = useState(1)
  const [isFs, setIsFs] = useState(false)
  const hideTimer = useRef(0)
  /** the show behind us owned document fullscreen before we took it */
  const hadDocFs = useRef(false)

  const poke = () => {
    setShowBar(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setShowBar(false), 3000)
  }
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  // Esc leaves OUR fullscreen first (browser-owned); hand document fullscreen
  // straight back to the show, otherwise its ~150ms loss timer ends the show.
  useEffect(() => {
    const onFs = () => {
      if (document.fullscreenElement === wrapRef.current) {
        setIsFs(true)
        return
      }
      setIsFs(false)
      if (hadDocFs.current) {
        hadDocFs.current = false
        void document.documentElement.requestFullscreen?.().catch(() => {})
      }
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const goFs = () => {
    if (document.fullscreenElement === wrapRef.current) {
      void document.exitFullscreen().catch(() => {})
      return
    }
    hadDocFs.current = !!document.fullscreenElement
    void wrapRef.current?.requestFullscreen().catch(() => {})
  }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <div
      ref={wrapRef}
      style={{ ...style, background: '#000' }}
      onMouseMove={poke}
      onMouseLeave={() => {
        window.clearTimeout(hideTimer.current)
        setShowBar(false)
      }}
    >
      <video
        ref={(el) => {
          videoRef.current = el
          setRef(el)
        }}
        src={src}
        style={{ width: '100%', height: '100%', display: 'block' }}
        playsInline
        muted={muted}
        onClick={(e) => {
          e.stopPropagation()
          const el = e.currentTarget
          poke()
          onToggle(el)
        }}
        onPlay={() => {
          setPaused(false)
          onPlay()
        }}
        onPause={() => {
          setPaused(true)
          onPause()
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDur(e.currentTarget.duration)
          setVol(e.currentTarget.volume)
        }}
        onVolumeChange={(e) => setVol(e.currentTarget.volume)}
      />
      {showBar && (
        <div
          data-media-controls
          onClick={stop}
          onMouseDown={stop}
          onMouseUp={stop}
          onKeyDown={stop}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '12px 16px',
            background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
            color: '#fff',
            fontSize: 18,
          }}
        >
          <button
            aria-label={paused ? 'Play' : 'Pause'}
            onClick={(e) => {
              e.stopPropagation()
              const el = videoRef.current
              if (el) onToggle(el)
            }}
            style={barBtn}
          >
            {paused ? '\u25B6' : '\u23F8'}
          </button>
          <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {formatTime(time)} / {formatTime(dur)}
          </span>
          <input
            aria-label="Seek"
            type="range"
            min={0}
            max={dur || 0}
            step={0.1}
            value={Math.min(time, dur || 0)}
            onChange={(e) => {
              const el = videoRef.current
              if (el) el.currentTime = parseFloat(e.target.value)
            }}
            style={{ flex: 1, height: 28, accentColor: '#fff' }}
          />
          <span aria-label="Volume" style={{ fontSize: 22 }}>
            {'\uD83D\uDD0A'}
          </span>
          <input
            aria-label="Volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={vol}
            onChange={(e) => {
              const el = videoRef.current
              if (el) el.volume = parseFloat(e.target.value)
            }}
            style={{ width: 110, height: 28, accentColor: '#fff' }}
          />
          <button
            aria-label={isFs ? 'Exit fullscreen' : 'Fullscreen'}
            onClick={(e) => {
              e.stopPropagation()
              goFs()
            }}
            style={barBtn}
          >
            {isFs ? '\u2715' : '\u26F6'}
          </button>
        </div>
      )}
    </div>
  )
}

const barBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 26,
  lineHeight: 1,
  padding: '8px 12px',
}
export function runMediaCommand(el: HTMLMediaElement, effect: MediaCommand['effect']): void {
  switch (effect) {
    case 'mediaPlay':
      el.currentTime = 0
      void el.play().catch(() => {})
      break
    case 'mediaPause':
      if (el.paused) void el.play().catch(() => {})
      else el.pause()
      break
    case 'mediaStop':
      el.pause()
      el.currentTime = 0
      break
  }
}
