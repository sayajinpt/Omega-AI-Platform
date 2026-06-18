import type { ContentGenerationCatalog } from '@omega/sdk'
import { engineClient } from './engine'

/** Runtime catalog (disk scan under ~/.omega/models/generation-models). */
export async function loadGenerationCatalog(): Promise<ContentGenerationCatalog> {
  const c = await engineClient.contentStudio.generation.catalog()
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    throw new Error('generation catalog unavailable')
  }
  return c as ContentGenerationCatalog
}
