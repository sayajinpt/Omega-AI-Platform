import type { HFSearchOptions } from './index.js'
import { pipelinePrefersAnyFormat } from './hf-pipeline-tasks.js'

/** UI → API options for HuggingFace model search (verified quantizers default lives in main `searchHF`). */
export function buildHfSearchOptions(input: {
  query?: string
  author?: string
  tag?: string
  pipeline?: string
  sort?: HFSearchOptions['sort']
  limit?: number
  format?: HFSearchOptions['format']
  /** When true and format is gguf with no author filter, restrict to curated quantizer accounts. */
  preferVerifiedQuantizers?: boolean
}): HFSearchOptions {
  const pipelineTag = input.pipeline?.trim() || undefined
  let format = input.format ?? 'gguf'
  if (pipelineTag && pipelinePrefersAnyFormat(pipelineTag) && format === 'gguf' && !input.format) {
    format = 'any'
  }
  const author = input.author?.trim()
  return {
    query: input.query?.trim() || undefined,
    author: author || undefined,
    tag: input.tag?.trim() || undefined,
    pipelineTag,
    sort: input.sort,
    limit: input.limit,
    format,
    verifiedOnly: Boolean(
      input.preferVerifiedQuantizers && !author && format === 'gguf' && !pipelineTag
    )
  }
}
