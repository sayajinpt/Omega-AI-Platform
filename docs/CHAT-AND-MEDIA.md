# Chat, attachments, and media

Omega chat is built around **sessions** stored in SQLite. Messages can be plain text or carry **parts** and **attachments** for images and files.

## Message model (`@omega/sdk`)

```ts
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; ref: string; alt?: string }
  | { type: 'audio'; ref: string }
  | { type: 'video'; ref: string }
  | { type: 'file'; ref: string; name: string; mime?: string; sizeBytes?: number }

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string                    // text fallback for all backends
  parts?: MessagePart[]
  attachments?: MediaRef[]
}

export interface MediaRef {
  id: string
  kind: 'image' | 'audio' | 'video' | 'file'
  path: string                       // under ~/.omega
  mime: string
  name?: string
  sizeBytes?: number
}
```

`content` always has a readable string (e.g. text plus `[Image: photo.png]`) so older sessions and text-only models still work.

## Desktop IPC (renderer → main)

| Channel | Purpose |
|---------|---------|
| `omega:chat:pick-attachments` | Open file picker; returns paths |
| `omega:chat:stage-attachment` | Copy into `~/.omega/sessions/<sessionId>/` → `MediaRef` |
| `omega:chat:attachment-limits` | Max bytes and count |
| `omega:stream:token` | Streaming text tokens |
| `omega:stream:media` | Assistant media parts (e.g. generated image) |
| `omega:stream:metrics` | Companion inference telemetry |

Preload API: `window.omega.chat.pickAttachments()`, `stageAttachment(sessionId, path)`, `send({ … attachments })`.

Staging implementation: `apps/desktop/src/main/services/chat-media.ts`.

## UI

- **ChatComposer** — paperclip attach, pending chips, send with attachments.
- **Message bubbles** — render `parts` where present; images via `omega-media://` protocol.
- **Companion** — quick chat and screen snip can attach to the **active main chat** (not a separate session). See README Companion section.

## Vision (image → model)

When a message includes images:

- Staged files are copied to `~/.omega/projects/<sessionId>/media/` and referenced as `parts` + `imagePaths` on the user message before chat send.
- **omega-engine (GGUF)** — `imagePaths` on messages (mtmd / mmproj when the model supports vision).
- **Ollama** — native `/api/chat` with base64 `images` when `imagePaths` are present (vision models such as llava, moondream, etc.).
- **Remote OpenAI-compatible** — `imagePaths` are converted to `image_url` content parts automatically.
- Text-only models return a clear error with suggested vision models from the catalog.

## Files, PDF, and audio attachments

On send, `prepare_chat_messages_for_inference` runs for every chat path (orchestrator, agent, simple):

| Kind | Behavior |
|------|----------|
| **Code / text** | Inlined into `content` (up to ~48 KB) for the model and orchestrator. |
| **PDF** | Text extracted via `pdftotext` on PATH when available, then inlined like a code block. |
| **Image** | `imagePaths` for vision backends; label in `content` for text-only models. |
| **Audio** | Transcribed with Ollama `/api/transcribe` when Ollama is running (model: `chat.attachmentSttModel`, or `omegaTools.voiceSttModelId` when not `browser`, default `whisper`). Transcript is appended to `content`. |
| **Video** | Listed in orchestrator `USER_ATTACHMENTS`; not frame-decoded yet. |

Orchestrator PROMPT_1/2 receive a `USER_ATTACHMENTS` section describing what was staged.

## Assistant-generated media

- `streamMedia` IPC pushes `MessagePart` chunks during agent/chat streams.
- Tool `image_generate` can attach images to the assistant message.
- Renderer listens with `window.omega.chat.onMedia()`.

## Voice

- Settings → enable voice for TTS on replies when supported.
- Companion quick chat can use OS speech recognition for input when available.
- Attached audio files use Ollama STT during send (see table above), not only live mic capture.

## Storage layout

```
~/.omega/
  sessions/<sessionId>/
    staged files, thumbnails
```

Do not reference dev-only paths in production; staging always goes through `stageAttachment`.

## HTTP API

OpenAI-style chat endpoints accept the same message shapes where implemented. Multipart upload parity for external clients is still limited — prefer the desktop IPC path for attachments today.
