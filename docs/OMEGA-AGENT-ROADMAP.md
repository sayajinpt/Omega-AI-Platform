# Omega agent roadmap

Omega ships one native agent stack inside the desktop app. There is **no Hermes Desktop runtime** in Omega — no Hermes branding, installer, or embedded app. The goal is an **Omega agent** that matches and exceeds the capabilities people associate with standalone agent desktops (memory, tools, office presence, gateways, self-improvement), implemented only with Omega code and config.

## Principles

1. **Single product identity** — UI and docs say Omega Agent / Omega Office, not third-party agent names.
2. **Visualization is optional** — Office 3D view can stop while agents, MoA, gateways, and chat continue.
3. **Local-first** — node-llama-cpp, profiles, and `.omega` data stay on device unless the user opts into cloud models.
4. **Parity then exceed** — implement expected agent-desktop behaviors first, then Omega-only features (model studio, companion, kanban bridge).

## Capability map

| Area | Today in Omega | Next (Omega-native) |
|------|----------------|---------------------|
| Chat + tools | Agent loop, slash commands, workspace tools | Richer tool registry UI; per-session tool policies |
| Memory | Facts store, session search (FTS5) | Long-horizon memory graph; automatic consolidation |
| Self-improve | Post-chat reflect, janitor, `/reflect` | Scheduled reflect; skill proposals from failures |
| Workforce | Delegate, MoA, parallel, standup | Persistent workforce roster; role templates |
| Office | 3D view + monitors + kanban pins | Floor layouts per project; standup recordings |
| Gateways | Many channel adapters | Unified gateway health dashboard; retry policies |
| Skills | Packaged + marketplace hooks via office engine | Omega skill vault in Settings (no external app) |
| Voice / media | Companion voice, media player hooks | Hands-free agent mode tied to active session |
| Models | Model Studio, hub, finetune path | One-click profile ↔ model binding |
| Updates | electron-updater | Channel notes + rollback hint in UI |

## Phase 1 — Agent core

- [x] Office page: 3D visualization only; start/stop does not cancel work
- [x] Gateway adapter drives avatar activity from real sessions
- [x] Self-improve on by default
- [x] Document all slash commands in in-app help (`/help` modal + catalog)
- [x] Agent step stream visible in Chat and Office consistently
- [x] Clear error surfaces when local model or gateway fails (actionable copy)

## Phase 2 — Memory and context

- [x] Session summaries auto-linked to memory facts
- [x] “What Omega knows about this project” panel in Chat
- [x] Export/import memory bundle per profile
- [x] Janitor rules configurable (age, size, dedupe)

## Phase 3 — Workforce and office

- [ ] Saved MoA templates and recurring standups
- [ ] Monitor presets (repo + Jira project)
- [ ] Office view auto-start option (off by default for GPU)
- [ ] Presence sync when view is stopped (queue for next start)

## Phase 4 — Gateways and integrations

- [ ] Gateway wizard in Settings (token test per channel)
- [ ] Webhook signing + rotation
- [ ] GitHub/Jira OAuth where tokens today are manual
- [ ] Rate-limit aware polling for monitors

## Phase 5 — Omega-only differentiators

- [ ] Per-model performance presets in agent mode
- [ ] Model Studio → deploy to profile in one step
- [ ] Companion ↔ office deep link (jump to agent at desk)
- [ ] Kanban task → workforce dispatch from board UI

## Non-goals

- Bundling or requiring Hermes Desktop (or any separate agent app).
- Renaming the bundled 3D engine folder in the repo (`claw3d-office` is an internal build artifact only).
- Stopping agent work when the user stops the Office view.

## Reference (development only)

Historical behavior from other agent desktops may be used **only while implementing** Omega features. Shipped Omega builds must not depend on or advertise those products.
