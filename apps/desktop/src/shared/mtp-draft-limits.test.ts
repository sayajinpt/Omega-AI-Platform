import { describe, expect, it } from 'vitest'
import {
  MTP_DRAFT_NMAX_ABSOLUTE,
  MTP_DRAFT_NMAX_DEFAULT,
  clampMtpDraftLimits
} from './mtp-draft-limits'

describe('clampMtpDraftLimits', () => {
  it('defaults nMax to 2', () => {
    expect(clampMtpDraftLimits(undefined, undefined).nMax).toBe(MTP_DRAFT_NMAX_DEFAULT)
  })

  it('caps nMax at absolute max', () => {
    expect(clampMtpDraftLimits(12, 2).nMax).toBe(MTP_DRAFT_NMAX_ABSOLUTE)
  })

  it('keeps valid manual values', () => {
    expect(clampMtpDraftLimits(2, 0).nMax).toBe(MTP_DRAFT_NMAX_DEFAULT)
  })
})
