# omega-engine — Native inference host

C++20 production host for GGUF inference over a stdio JSON-line protocol. Implements the `@omega/sdk` engine contract for model inventory, load/unload (LRU ×2), generate, embed, and chat.

## Layout

```
include/omega/engine/
  command.hpp          Command / response / event envelopes
  dispatcher.hpp       Thread-safe command routing
  event_bus.hpp        In-process pub/sub
  engine.hpp           Application facade
  json_protocol.hpp    nlohmann/json parse/serialize
  model_registry.hpp   Directory scan for .gguf models
  inference_service.hpp  libomega_infer wrapper (multi-model LRU)
  inference_worker.hpp   Inference thread (load/generate/embed/chat)
  runtime/thread_pool.hpp  Service pool for registry scans
  runtime/dispatch_metrics.hpp  IPC latency probes
native/                libomega_infer + llama.cpp (CMake submodule)
src/
  main.cpp             stdio JSON-line host
```

## Build

```powershell
# From repo root (links libomega_infer when apps/engine/native exists)
.\scripts\build-engine.ps1

# Force llama.cpp linkage
.\scripts\build-engine.ps1 -LinkInfer
```

CMake enables `OMEGA_ENGINE_LINK_INFER` by default when `apps/engine/native/CMakeLists.txt` is present. Output: `dist/engine/omega-engine.exe` (Windows) or `dist/engine/omega-engine` (Unix).

## Models directory

Resolution order:

1. `--models-dir <path>` CLI flag
2. `$OMEGA_HOME/models`
3. `~/.omega/models` (or `%USERPROFILE%\.omega\models` on Windows)

The registry scans recursively for `.gguf` files and skips auxiliary vision projectors (`mmproj`, `clip`, `-vision` in the filename).

## Protocol

Request (one JSON object per line):

```json
{"id":"1","type":"health","payload":{}}
```

Response:

```json
{"id":"1","type":"health","success":true,"data":{"ok":true,"version":"1.0.0","infer_available":true}}
```

Key commands: `model.load`, `model.unload`, `model.loaded`, `chat.send`, `chat.generate`, `chat.embed`.

Streaming events (`chat.generate`):

```json
{"event":"ChatChunkReceived","at":1234567890,"payload":{"sessionId":"…","text":"Hello","index":0}}
```
