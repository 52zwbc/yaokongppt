import { describe, expect, it } from 'vitest'
import { formatTime } from '../src/renderer/components/ShowMediaLayer'

describe('formatTime', () => {
  it('formats seconds as m:ss', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(600)).toBe('10:00')
  })

  it('floors fractional seconds', () => {
    expect(formatTime(3.9)).toBe('0:03')
  })

  it('falls back to 0:00 for unloaded metadata', () => {
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(-1)).toBe('0:00')
  })
})
