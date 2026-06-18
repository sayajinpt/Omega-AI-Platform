import type { HFSearchOptions } from './index.js'

/** UI → API options for HuggingFace model search (verified quantizers default lives in main `searchHF`). */
export function buildHfSearchOptions(input: {
  query?: string
  author?: string
  tag?: string
  sort?: HFSearchOptions['sort']
  limit?: number
  format?: HFSearchOptions['format']
  /** When true and format is gguf with no author filter, restrict to curated quantizer accounts. */
  preferVerifiedQuantizers?: boolean
}): HFSearchOptions {
  const format = input.format ?? 'gguf'
  const author = input.author?.trim()
  return {
    query: input.query?.trim() || undefined,
    author: author || undefined,
    tag: input.tag?.trim() || undefined,
    sort: input.sort,
    limit: input.limit,
    format,
    verifiedOnly: Boolean(
      input.preferVerifiedQuantizers && !author && format === 'gguf'
    )
  }
}
