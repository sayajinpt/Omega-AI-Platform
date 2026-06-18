# Office, gateways, and integrations

Omega ships a native **Office** page: optional **3D workforce visualization**, workforce tasks (MoA, standup), monitor wall (GitHub PR, Jira), and kanban pins. Chat **gateways** and the **Omega Companion** are separate surfaces.

The **Omega Companion** (floating 3D widget) is not the Office view. Companion messages route to your current or last-open main chat.

## Status

| Feature | Status |
|---------|--------|
| Office 3D view (start/stop, bundled engine) | ✅ |
| Stop view ≠ stop agents / MoA / chat | ✅ |
| Multi-agent: delegate, MoA, parallel | ✅ |
| Live agent steps in Office sidebar | ✅ |
| Slash commands (~22) | ✅ |
| Cloud usage / cost tracking | ✅ |
| Session FTS5 search | ✅ |
| Self-improve reflect + janitor | ✅ |
| Auto-updater (electron-updater) | ✅ |
| Gateways: Telegram, Discord, Slack, webhook | ✅ |
| Gateways: Matrix, Mattermost, DingTalk, Feishu, WeCom, HA, WhatsApp, BlueBubbles | ✅ |
| Gateways: SMS (Twilio), Signal, Email, Weixin | ✅ |
| PR diff monitors + comment/approve | ✅ |
| Jira issue monitors + comment | ✅ |
| Integrations settings (GitHub/Jira tokens) | ✅ |
| Kanban ↔ Office (pin, monitor, workforce dispatch) | ✅ |
| Scheduled PR/Jira monitor polling | ✅ |
| Skill gym + office janitor workflows | ✅ |
| Omega tools (voice, media player, Content Studio defaults) | ✅ |

Removed from product UI: native 2D isometric floor and dual Office tabs.

## Key paths

- Office UI: `apps/desktop/src/renderer/src/pages/OfficePage.tsx`, `components/OfficeVisualization.tsx`
- Visualization service: `apps/desktop/src/main/claw3d/service.ts` (internal folder name; user-facing label is **Office**)
- Adapter: `apps/desktop/scripts/omega-claw3d-adapter.mjs`
- Workforce: `apps/desktop/src/main/workforce/`
- Gateways: `apps/desktop/src/main/services/gateway.ts`

## Office 3D view

- Bundled engine lives in `apps/desktop/claw3d-office/` (built during `build.bat`).
- **Start office view** / **Stop office view** on the Office page control only the HTTP server, WebSocket gateway adapter, and iframe — not workforce runs, chat streams, or agent tool execution.
- Walking avatars: Omega pushes activity to `POST /ingest/presence`; the adapter emits gateway `status` + `agent` events from workforce and session state.
- Run Agent, MoA, or delegate tasks while the view is on to see planners and executors at desks.

## Self-improve

- Enabled by default: `selfImproveEnabled` in config (Settings → Permissions).
- After each chat, Omega reflects on the session → `~/.omega/self-improve.json` + optional memory fact.
- Also available via `/reflect` and `/janitor` slash commands.
