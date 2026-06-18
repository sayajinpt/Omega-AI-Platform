/**
 * Curated Discover catalog — graphical cards in Model Studio (one-click GGUF download).
 *
 * For any model on Hugging Face, use Browse HF (search + paste owner/repo).
 * Entries here are staff picks and may lag behind HF; verify repos before shipping updates.
 */
export interface HubEntry {
  id: string
  name: string
  description: string
  repo: string
  file: string
  params: string
  quant: string
  /** Approximate file size in GB. */
  sizeGb?: number
  category:
    | 'chat'
    | 'coder'
    | 'reasoning'
    | 'vision'
    | 'embedding'
    | 'math'
    | 'small'
    | 'large'
    | 'tools'
  tags: string[]
  /** Release year for sorting / display. */
  year?: number
}

/** Public Hugging Face model page for a hub entry. */
export function hubModelPageUrl(repo: string): string {
  return `https://huggingface.co/${repo.trim().replace(/^\/+|\/+$/g, '')}`
}

export const MODEL_HUB: HubEntry[] = [
  // ══════════════════════════════════════════════════════════════════════
  //  ★ NEW — 2026 releases (Apr-May 2026)
  // ══════════════════════════════════════════════════════════════════════
  { id: 'qwen3.6-35b-a3b', name: 'Qwen 3.6 35B-A3B', description: 'Latest Qwen MoE (35B total / 3B active). Top open agentic + coding model right now.', repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', file: 'Qwen3.6-35B-A3B-Q4_K_M.gguf', params: '35B-A3B MoE', quant: 'Q4_K_M', sizeGb: 21.0, category: 'chat', tags: ['new', 'popular', 'recommended', 'agent', 'moe'], year: 2026 },
  { id: 'qwen3.6-27b', name: 'Qwen 3.6 27B', description: 'Dense Qwen 3.6 — strong general-purpose model, better stability than 3.5.', repo: 'unsloth/Qwen3.6-27B-GGUF', file: 'Qwen3.6-27B-Q4_K_M.gguf', params: '27B', quant: 'Q4_K_M', sizeGb: 16.6, category: 'chat', tags: ['new', 'popular', 'agent'], year: 2026 },
  { id: 'gemma-4-31b', name: 'Gemma 4 31B IT', description: 'Google flagship dense — #3 on Arena, 256k ctx, multimodal, Apache 2.0.', repo: 'lmstudio-community/gemma-4-31B-it-GGUF', file: 'gemma-4-31B-it-Q4_K_M.gguf', params: '31B', quant: 'Q4_K_M', sizeGb: 19.0, category: 'chat', tags: ['new', 'popular', 'recommended', 'vision', 'long-context'], year: 2026 },
  { id: 'gemma-4-26b-a4b', name: 'Gemma 4 26B-A4B', description: 'Gemma MoE (4B active). Outcompetes models 20× its activated size.', repo: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF', file: 'gemma-4-26B-A4B-it-Q4_K_M.gguf', params: '26B-A4B MoE', quant: 'Q4_K_M', sizeGb: 15.8, category: 'chat', tags: ['new', 'popular', 'moe', 'long-context'], year: 2026 },
  { id: 'gemma-4-e4b', name: 'Gemma 4 E4B IT', description: 'Compact multimodal Gemma 4 (text/image/audio in). ~8B effective.', repo: 'lmstudio-community/gemma-4-E4B-it-GGUF', file: 'gemma-4-E4B-it-Q4_K_M.gguf', params: '~8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'vision', tags: ['new', 'popular', 'recommended', 'vision'], year: 2026 },
  { id: 'gemma-4-e2b', name: 'Gemma 4 E2B IT', description: 'Edge Gemma 4 (~5B). Multimodal, 128k ctx, runs on a laptop CPU.', repo: 'lmstudio-community/gemma-4-E2B-it-GGUF', file: 'gemma-4-E2B-it-Q4_K_M.gguf', params: '~5B', quant: 'Q4_K_M', sizeGb: 3.1, category: 'small', tags: ['new', 'popular', 'cpu', 'vision'], year: 2026 },
  { id: 'llama-4-scout', name: 'Llama 4 Scout 17B-16E', description: 'Meta MoE — 17B active / 109B total, 10M context window. Multimodal.', repo: 'unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF', file: 'Llama-4-Scout-17B-16E-Instruct-Q4_K_M.gguf', params: '17B-A/109B MoE', quant: 'Q4_K_M', sizeGb: 65.0, category: 'large', tags: ['new', 'popular', 'flagship', 'moe', 'long-context', 'vision'], year: 2026 },
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick 17B-128E', description: 'Larger Llama 4 — 17B active / 400B total, GPT-4-class quality.', repo: 'unsloth/Llama-4-Maverick-17B-128E-Instruct-GGUF', file: 'Llama-4-Maverick-17B-128E-Instruct-Q4_K_M.gguf', params: '17B-A/400B MoE', quant: 'Q4_K_M', sizeGb: 243.0, category: 'large', tags: ['new', 'flagship', 'moe'], year: 2026 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '284B / 13B-active MoE. Fast on commodity hardware, ~1M context.', repo: 'batiai/DeepSeek-V4-Flash-GGUF', file: 'DeepSeek-V4-Flash-Q4_K_M.gguf', params: '13B-A/284B MoE', quant: 'Q4_K_M', sizeGb: 161.0, category: 'large', tags: ['new', 'flagship', 'moe', 'long-context'], year: 2026 },
  { id: 'mistral-medium-3.5', name: 'Mistral Medium 3.5 128B', description: 'Dense Mistral flagship — 77.6 SWE-Bench Verified, 256k ctx.', repo: 'unsloth/Mistral-Medium-3.5-128B-GGUF', file: 'Mistral-Medium-3.5-128B-Q4_K_M.gguf', params: '128B', quant: 'Q4_K_M', sizeGb: 73.0, category: 'large', tags: ['new', 'flagship', 'long-context'], year: 2026 },
  { id: 'qwen3.5-235b-a22b', name: 'Qwen 3.5 235B-A22B', description: 'Earlier-2026 Qwen MoE — still very strong reasoning + agent.', repo: 'unsloth/Qwen3.5-235B-A22B-Instruct-GGUF', file: 'Qwen3.5-235B-A22B-Instruct-Q4_K_M.gguf', params: '22B-A/235B MoE', quant: 'Q4_K_M', sizeGb: 142.0, category: 'large', tags: ['new', 'flagship', 'moe'], year: 2026 },

  // ══════════════════════════════════════════════════════════════════════
  //  ★ Popular workhorses — 2025 models still in heavy daily use
  // ══════════════════════════════════════════════════════════════════════
  { id: 'qwen3-8b', name: 'Qwen 3 8B', description: 'Sweet spot 2025 8B — strong chat / agent / coder. The new default 7B-class.', repo: 'bartowski/Qwen_Qwen3-8B-GGUF', file: 'Qwen_Qwen3-8B-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'chat', tags: ['popular', 'recommended', 'agent'], year: 2025 },
  { id: 'qwen3-14b', name: 'Qwen 3 14B', description: 'Mid-size Qwen 3 — excellent quality-per-VRAM in the 14B class.', repo: 'bartowski/Qwen_Qwen3-14B-GGUF', file: 'Qwen_Qwen3-14B-Q4_K_M.gguf', params: '14B', quant: 'Q4_K_M', sizeGb: 9.0, category: 'chat', tags: ['popular', 'recommended', 'agent'], year: 2025 },
  { id: 'qwen3-30b-a3b', name: 'Qwen 3 30B-A3B', description: 'Qwen MoE — 30B total, 3B active. Massive speed-per-quality win.', repo: 'bartowski/Qwen_Qwen3-30B-A3B-GGUF', file: 'Qwen_Qwen3-30B-A3B-Q4_K_M.gguf', params: '30B-A3B MoE', quant: 'Q4_K_M', sizeGb: 18.5, category: 'chat', tags: ['popular', 'recommended', 'moe', 'agent'], year: 2025 },
  { id: 'qwen3-4b', name: 'Qwen 3 4B', description: 'Compact Qwen 3 — better than Qwen 2.5 7B in many tasks.', repo: 'bartowski/Qwen_Qwen3-4B-GGUF', file: 'Qwen_Qwen3-4B-Q4_K_M.gguf', params: '4B', quant: 'Q4_K_M', sizeGb: 2.5, category: 'small', tags: ['popular', 'cpu'], year: 2025 },
  { id: 'qwen3-32b', name: 'Qwen 3 32B', description: 'Dense Qwen 3 flagship — competitive with 70B-class models.', repo: 'bartowski/Qwen_Qwen3-32B-GGUF', file: 'Qwen_Qwen3-32B-Q4_K_M.gguf', params: '32B', quant: 'Q4_K_M', sizeGb: 19.9, category: 'large', tags: ['popular', 'flagship'], year: 2025 },
  { id: 'gemma-3-27b', name: 'Gemma 3 27B IT', description: 'Google 27B (2025) — multimodal, 128k ctx. Still a top open model.', repo: 'bartowski/gemma-3-27b-it-GGUF', file: 'gemma-3-27b-it-Q4_K_M.gguf', params: '27B', quant: 'Q4_K_M', sizeGb: 16.6, category: 'large', tags: ['popular', 'vision', 'long-context'], year: 2025 },
  { id: 'gemma-3-12b', name: 'Gemma 3 12B IT', description: 'Mid-size multimodal Gemma 3 — strong all-rounder.', repo: 'bartowski/gemma-3-12b-it-GGUF', file: 'gemma-3-12b-it-Q4_K_M.gguf', params: '12B', quant: 'Q4_K_M', sizeGb: 7.3, category: 'chat', tags: ['popular', 'vision'], year: 2025 },
  { id: 'gemma-3-4b', name: 'Gemma 3 4B IT', description: 'Compact multimodal Gemma 3 — runs anywhere.', repo: 'bartowski/gemma-3-4b-it-GGUF', file: 'gemma-3-4b-it-Q4_K_M.gguf', params: '4B', quant: 'Q4_K_M', sizeGb: 2.5, category: 'small', tags: ['popular', 'cpu', 'vision'], year: 2025 },
  { id: 'deepseek-r1', name: 'DeepSeek R1 (full)', description: 'The original R1 reasoning flagship — 671B/37B-A MoE.', repo: 'unsloth/DeepSeek-R1-GGUF', file: 'DeepSeek-R1-UD-Q2_K_XL.gguf', params: '37B-A/671B MoE', quant: 'UD-Q2_K_XL', sizeGb: 211.0, category: 'reasoning', tags: ['popular', 'reasoning', 'flagship', 'moe'], year: 2025 },
  { id: 'r1-distill-qwen-32b', name: 'DeepSeek R1 Distill Qwen 32B', description: 'Best small R1 distill — near o1-mini quality at 32B.', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf', params: '32B', quant: 'Q4_K_M', sizeGb: 19.9, category: 'reasoning', tags: ['popular', 'recommended', 'reasoning'], year: 2025 },
  { id: 'r1-distill-llama-8b', name: 'DeepSeek R1 Distill Llama 8B', description: 'Compact R1 distill — popular for fast local reasoning.', repo: 'bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF', file: 'DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'reasoning', tags: ['popular', 'recommended', 'reasoning'], year: 2025 },
  { id: 'phi-4-14b', name: 'Phi-4 14B', description: 'Microsoft Phi-4 — exceptional reasoning per parameter.', repo: 'bartowski/phi-4-GGUF', file: 'phi-4-Q4_K_M.gguf', params: '14B', quant: 'Q4_K_M', sizeGb: 8.4, category: 'chat', tags: ['popular', 'recommended', 'reasoning'], year: 2025 },
  { id: 'phi-4-mini', name: 'Phi-4 Mini Instruct', description: 'Microsoft small model — fast and capable for its size.', repo: 'bartowski/Phi-4-mini-instruct-GGUF', file: 'Phi-4-mini-instruct-Q4_K_M.gguf', params: '3.8B', quant: 'Q4_K_M', sizeGb: 2.4, category: 'small', tags: ['popular', 'cpu'], year: 2025 },
  { id: 'mistral-small-3.1', name: 'Mistral Small 3.1 24B', description: 'Mistral 2025 mid-class — strong agent + tool use.', repo: 'bartowski/Mistral-Small-3.1-24B-Instruct-2503-GGUF', file: 'Mistral-Small-3.1-24B-Instruct-2503-Q4_K_M.gguf', params: '24B', quant: 'Q4_K_M', sizeGb: 14.3, category: 'chat', tags: ['popular', 'agent'], year: 2025 },
  {
    id: 'devstral-24b',
    name: 'Mistral Devstral Small 2 24B',
    description: 'Mistral coding-agent (Dec 2025) — agentic SWE tasks, 256k ctx. Accept HF license before download.',
    repo: 'bartowski/mistralai_Devstral-Small-2-24B-Instruct-2512-GGUF',
    file: 'Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf',
    params: '24B',
    quant: 'Q4_K_M',
    sizeGb: 14.3,
    category: 'coder',
    tags: ['popular', 'code', 'agent'],
    year: 2025
  },
  { id: 'magistral-small-24b', name: 'Mistral Magistral Small 24B', description: 'Mistral reasoning model — open-source o1-style chain-of-thought.', repo: 'bartowski/Magistral-Small-2506-GGUF', file: 'Magistral-Small-2506-Q4_K_M.gguf', params: '24B', quant: 'Q4_K_M', sizeGb: 14.3, category: 'reasoning', tags: ['popular', 'reasoning'], year: 2025 },
  { id: 'kimi-k2', name: 'Kimi K2 (Moonshot)', description: 'Moonshot AI 1T/32B-A MoE — tops several open agent benchmarks.', repo: 'unsloth/Kimi-K2-Instruct-GGUF', file: 'Kimi-K2-Instruct-Q4_K_M.gguf', params: '32B-A/1T MoE', quant: 'Q4_K_M', sizeGb: 580.0, category: 'large', tags: ['popular', 'flagship', 'moe', 'agent'], year: 2025 },
  { id: 'glm-4.5', name: 'GLM-4.5', description: 'Zhipu AI flagship — open SOTA agentic + coding (precursor to 5.1).', repo: 'bartowski/GLM-4.5-Air-GGUF', file: 'GLM-4.5-Air-Q4_K_M.gguf', params: '107B-A/12B MoE', quant: 'Q4_K_M', sizeGb: 62.0, category: 'large', tags: ['popular', 'flagship', 'moe', 'agent'], year: 2025 },
  { id: 'hermes-4-llama-3.1-8b', name: 'Hermes 4 (Llama 3.1 8B)', description: 'Nous Research 2025 finetune — top open function-calling model.', repo: 'bartowski/Hermes-4-Llama-3.1-8B-GGUF', file: 'Hermes-4-Llama-3.1-8B-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'tools', tags: ['popular', 'recommended', 'agent', 'function-calling'], year: 2025 },
  { id: 'hermes-4-llama-3.1-70b', name: 'Hermes 4 (Llama 3.1 70B)', description: 'Nous flagship — top-tier open agent model.', repo: 'bartowski/Hermes-4-Llama-3.1-70B-GGUF', file: 'Hermes-4-Llama-3.1-70B-Q4_K_M.gguf', params: '70B', quant: 'Q4_K_M', sizeGb: 42.5, category: 'tools', tags: ['flagship', 'agent', 'function-calling'], year: 2025 },
  { id: 'qwen2.5-coder-32b', name: 'Qwen 2.5 Coder 32B', description: 'Still the best open coder per VRAM at 32B — Qwen 3.6 will beat it eventually.', repo: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF', file: 'Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf', params: '32B', quant: 'Q4_K_M', sizeGb: 19.9, category: 'coder', tags: ['popular', 'code', 'flagship'], year: 2024 },

  // ══════════════════════════════════════════════════════════════════════
  //  Llama 3.x — workhorses (still widely used)
  // ══════════════════════════════════════════════════════════════════════
  { id: 'llama-3.3-70b', name: 'Llama 3.3 70B Instruct', description: 'Meta 70B (Dec 2024) — near 405B quality. Still very popular.', repo: 'bartowski/Llama-3.3-70B-Instruct-GGUF', file: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf', params: '70B', quant: 'Q4_K_M', sizeGb: 42.5, category: 'large', tags: ['popular', 'flagship'], year: 2024 },
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B Instruct', description: 'Classic Meta 8B with 128k ctx — the safe-bet workhorse.', repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'chat', tags: ['popular', 'long-context'], year: 2024 },
  { id: 'llama-3.2-3b', name: 'Llama 3.2 3B Instruct', description: 'Compact Llama for low-VRAM systems and quick agents.', repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', params: '3B', quant: 'Q4_K_M', sizeGb: 2.0, category: 'small', tags: ['popular', 'cpu'], year: 2024 },
  { id: 'llama-3.2-1b', name: 'Llama 3.2 1B Instruct', description: 'Edge Llama for embedded scenarios.', repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', params: '1B', quant: 'Q4_K_M', sizeGb: 0.8, category: 'small', tags: ['cpu'], year: 2024 },

  // ══════════════════════════════════════════════════════════════════════
  //  Coding family (more)
  // ══════════════════════════════════════════════════════════════════════
  { id: 'qwen2.5-coder-7b', name: 'Qwen 2.5 Coder 7B', description: 'Top 7B-class open coder. Use Qwen 3 Coder once 7B variant lands.', repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', params: '7B', quant: 'Q4_K_M', sizeGb: 4.7, category: 'coder', tags: ['code', 'popular'], year: 2024 },
  { id: 'qwen2.5-coder-14b', name: 'Qwen 2.5 Coder 14B', description: 'Stronger Coder for refactors and long files.', repo: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF', file: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf', params: '14B', quant: 'Q4_K_M', sizeGb: 9.0, category: 'coder', tags: ['code'], year: 2024 },
  { id: 'deepseek-coder-v2-lite', name: 'DeepSeek Coder V2 Lite', description: 'MoE code model, fast tokens-per-active-param.', repo: 'bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF', file: 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf', params: '16B-MoE', quant: 'Q4_K_M', sizeGb: 10.4, category: 'coder', tags: ['code', 'moe'], year: 2024 },
  { id: 'codestral-22b', name: 'Codestral 22B', description: 'Mistral code model — fluent across 80+ languages.', repo: 'bartowski/Codestral-22B-v0.1-GGUF', file: 'Codestral-22B-v0.1-Q4_K_M.gguf', params: '22B', quant: 'Q4_K_M', sizeGb: 13.3, category: 'coder', tags: ['code'], year: 2024 },

  // ══════════════════════════════════════════════════════════════════════
  //  Reasoning family (more)
  // ══════════════════════════════════════════════════════════════════════
  { id: 'qwq-32b', name: 'QwQ 32B', description: 'Qwen reasoning model — strong chain-of-thought open release.', repo: 'bartowski/QwQ-32B-GGUF', file: 'QwQ-32B-Q4_K_M.gguf', params: '32B', quant: 'Q4_K_M', sizeGb: 19.9, category: 'reasoning', tags: ['reasoning', 'flagship'], year: 2025 },
  { id: 'r1-distill-qwen-14b', name: 'DeepSeek R1 Distill Qwen 14B', description: 'Stronger R1 distill — solid step-by-step reasoning.', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', params: '14B', quant: 'Q4_K_M', sizeGb: 9.0, category: 'reasoning', tags: ['reasoning'], year: 2025 },
  { id: 'r1-distill-qwen-7b', name: 'DeepSeek R1 Distill Qwen 7B', description: 'Compact reasoner distilled from R1.', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf', params: '7B', quant: 'Q4_K_M', sizeGb: 4.7, category: 'reasoning', tags: ['reasoning'], year: 2025 },

  // ══════════════════════════════════════════════════════════════════════
  //  Vision (more)
  // ══════════════════════════════════════════════════════════════════════
  { id: 'qwen2.5-vl-7b', name: 'Qwen 2.5-VL 7B', description: 'Strong Qwen vision — handles documents, charts, video frames.', repo: 'bartowski/Qwen2.5-VL-7B-Instruct-GGUF', file: 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', params: '7B', quant: 'Q4_K_M', sizeGb: 4.7, category: 'vision', tags: ['vision', 'popular'], year: 2025 },
  { id: 'qwen2.5-vl-32b', name: 'Qwen 2.5-VL 32B', description: 'Larger Qwen vision — best open VLM at this size.', repo: 'bartowski/Qwen2.5-VL-32B-Instruct-GGUF', file: 'Qwen2.5-VL-32B-Instruct-Q4_K_M.gguf', params: '32B', quant: 'Q4_K_M', sizeGb: 19.9, category: 'vision', tags: ['vision'], year: 2025 },
  { id: 'minicpm-v-2.6', name: 'MiniCPM-V 2.6 (8B)', description: 'Compact vision model — multi-image + OCR.', repo: 'openbmb/MiniCPM-V-2_6-gguf', file: 'ggml-model-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 5.5, category: 'vision', tags: ['vision'], year: 2024 },

  // ══════════════════════════════════════════════════════════════════════
  //  Embeddings
  // ══════════════════════════════════════════════════════════════════════
  { id: 'nomic-embed-text-v1.5', name: 'Nomic Embed Text v1.5', description: 'High-quality 768-d text embeddings (8k ctx).', repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', file: 'nomic-embed-text-v1.5.Q4_K_M.gguf', params: '137M', quant: 'Q4_K_M', sizeGb: 0.1, category: 'embedding', tags: ['embedding', 'recommended'] },
  { id: 'bge-large-en-v1.5', name: 'BGE Large EN v1.5', description: 'BAAI embedding model — strong English retrieval.', repo: 'CompendiumLabs/bge-large-en-v1.5-gguf', file: 'bge-large-en-v1.5-q4_k_m.gguf', params: '335M', quant: 'Q4_K_M', sizeGb: 0.2, category: 'embedding', tags: ['embedding'] },
  { id: 'mxbai-embed-large-v1', name: 'mxbai Embed Large v1', description: 'Mixedbread top-tier general-purpose embeddings.', repo: 'mixedbread-ai/mxbai-embed-large-v1', file: 'gguf/mxbai-embed-large-v1-f16.gguf', params: '335M', quant: 'F16', sizeGb: 0.7, category: 'embedding', tags: ['embedding'] },

  // ══════════════════════════════════════════════════════════════════════
  //  Legacy / small / community (kept for low-VRAM and niche needs)
  // ══════════════════════════════════════════════════════════════════════
  { id: 'qwen2.5-3b', name: 'Qwen 2.5 3B Instruct', description: 'Legacy small Qwen 2.5 — superseded by Qwen 3 4B.', repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF', file: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf', params: '3B', quant: 'Q4_K_M', sizeGb: 2.0, category: 'small', tags: ['legacy'], year: 2024 },
  { id: 'qwen2.5-7b', name: 'Qwen 2.5 7B Instruct', description: 'Legacy Qwen 2.5 — superseded by Qwen 3 8B.', repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', params: '7B', quant: 'Q4_K_M', sizeGb: 4.7, category: 'chat', tags: ['legacy'], year: 2024 },
  { id: 'mistral-7b-v0.3', name: 'Mistral 7B Instruct v0.3', description: 'The classic Mistral instruct baseline.', repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF', file: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf', params: '7B', quant: 'Q4_K_M', sizeGb: 4.4, category: 'chat', tags: ['legacy'], year: 2024 },
  { id: 'mistral-nemo-12b', name: 'Mistral Nemo 12B Instruct', description: 'Mistral 12B with 128k ctx.', repo: 'bartowski/Mistral-Nemo-Instruct-2407-GGUF', file: 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf', params: '12B', quant: 'Q4_K_M', sizeGb: 7.5, category: 'chat', tags: ['long-context'], year: 2024 },
  { id: 'gemma-2-9b', name: 'Gemma 2 9B IT', description: 'Solid older Gemma — replaced by Gemma 4 E4B for most users.', repo: 'bartowski/gemma-2-9b-it-GGUF', file: 'gemma-2-9b-it-Q4_K_M.gguf', params: '9B', quant: 'Q4_K_M', sizeGb: 5.8, category: 'chat', tags: ['legacy'], year: 2024 },
  { id: 'smollm2-1.7b', name: 'SmolLM2 1.7B Instruct', description: 'HuggingFace tiny instruct — clean and fast.', repo: 'bartowski/SmolLM2-1.7B-Instruct-GGUF', file: 'SmolLM2-1.7B-Instruct-Q4_K_M.gguf', params: '1.7B', quant: 'Q4_K_M', sizeGb: 1.1, category: 'small', tags: ['cpu'], year: 2024 },
  { id: 'granite-3.2-8b', name: 'IBM Granite 3.2 8B Instruct', description: 'IBM enterprise — Apache 2.0, reasoning-focused.', repo: 'bartowski/granite-3.2-8b-instruct-GGUF', file: 'granite-3.2-8b-instruct-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'chat', tags: ['enterprise'], year: 2025 },
  { id: 'aya-expanse-8b', name: 'Cohere Aya Expanse 8B', description: 'Multilingual model covering 23+ languages.', repo: 'bartowski/aya-expanse-8b-GGUF', file: 'aya-expanse-8b-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'chat', tags: ['multilingual'], year: 2024 },
  { id: 'dolphin-3.0-llama-8b', name: 'Dolphin 3.0 Llama 8B', description: 'Uncensored, instruction-following Llama 3.1 finetune.', repo: 'bartowski/Dolphin3.0-Llama3.1-8B-GGUF', file: 'Dolphin3.0-Llama3.1-8B-Q4_K_M.gguf', params: '8B', quant: 'Q4_K_M', sizeGb: 4.9, category: 'chat', tags: ['uncensored'], year: 2025 }
]
