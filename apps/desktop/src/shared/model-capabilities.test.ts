import { describe, expect, it } from 'vitest'
import { inferModelCapabilities, primaryModelTaskLabel } from '@omega/sdk'

describe('inferModelCapabilities pipeline_tag', () => {
  it('classifies text-to-video from HF pipeline_tag', () => {
    const caps = inferModelCapabilities({
      name: 'Lightricks/LTX-Video',
      pipeline: 'text-to-video',
      tags: ['diffusers']
    })
    expect(caps.some((c) => c.id === 'text-to-video')).toBe(true)
    expect(caps.some((c) => c.id === 'chat')).toBe(false)
  })

  it('classifies text-to-image without defaulting to chat', () => {
    const caps = inferModelCapabilities({
      name: 'black-forest-labs/FLUX.1-dev',
      pipeline: 'text-to-image'
    })
    expect(caps.some((c) => c.id === 'text-to-image')).toBe(true)
    expect(caps.some((c) => c.id === 'chat')).toBe(false)
  })

  it('primaryModelTaskLabel uses pipeline_tag', () => {
    expect(
      primaryModelTaskLabel({ name: 'org/model', pipeline: 'text-to-video', tags: [] })
    ).toBe('Text-to-Video')
  })
})
