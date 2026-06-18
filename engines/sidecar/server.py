#!/usr/bin/env python3
"""
Omega inference sidecar — OpenAI-compatible chat for EXL2 (ExLlamaV2) and ONNX GenAI.

Refs:
  - https://github.com/turboderp-org/exllamav2
  - https://github.com/microsoft/onnxruntime-genai
"""
from __future__ import annotations

import argparse
import json
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
import uvicorn

from backends.detect import detect_format
from backends.exl2_backend import Exl2Backend
from backends.onnx_backend import OnnxGenaiBackend
from backends.onnx_prepare import OnnxPrepareError

app = FastAPI(title="omega-sidecar")
exl2 = Exl2Backend()
onnx = OnnxGenaiBackend()
loaded_format: str | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "exl2_available": Exl2Backend.available(),
        "onnx_available": OnnxGenaiBackend.available(),
        "loaded_format": loaded_format,
        "loaded_path": exl2.path or onnx.path,
    }


@app.post("/internal/load")
def internal_load(body: dict[str, Any]) -> dict[str, str]:
    global loaded_format
    path = str(body.get("path") or "").strip()
    if not path:
        raise HTTPException(400, "path required")
    fmt = str(body.get("format") or detect_format(path) or "").lower()
    max_seq = int(body.get("max_seq_len") or 8192)
    if fmt == "exl2":
        if not Exl2Backend.available():
            raise HTTPException(
                503,
                "exllamav2 not installed — run: npm run setup:sidecar (from Omega/)",
            )
        exl2.load(path, max_seq_len=max_seq)
        loaded_format = "exl2"
        return {"format": "exl2", "path": path}
    if fmt == "onnx":
        if not OnnxGenaiBackend.available():
            raise HTTPException(
                503,
                "onnxruntime-genai not installed — run: npm run setup:sidecar (from Omega/)",
            )
        try:
            onnx.load(path)
        except OnnxPrepareError as e:
            raise HTTPException(503, str(e)) from e
        except Exception as e:
            raise HTTPException(503, f"ONNX GenAI load failed: {e}") from e
        loaded_format = "onnx"
        return {"format": "onnx", "path": path}
    raise HTTPException(400, f"unsupported format for path (detected: {fmt or 'unknown'})")


@app.post("/internal/unload")
def internal_unload() -> dict[str, bool]:
    global loaded_format
    exl2.unload()
    onnx.unload()
    loaded_format = None
    return {"ok": True}


def _active_backend():
    if loaded_format == "exl2":
        return exl2
    if loaded_format == "onnx":
        return onnx
    return None


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> StreamingResponse:
    body = await request.json()
    messages = body.get("messages") or []
    if not isinstance(messages, list):
        raise HTTPException(400, "messages must be an array")
    stream = bool(body.get("stream", True))
    temperature = float(body.get("temperature") or 0.7)
    top_p = float(body.get("top_p") or 0.9)
    max_tokens = int(body.get("max_tokens") or 2048)

    backend = _active_backend()
    if not backend:
        raise HTTPException(409, "no model loaded — call /internal/load first")

    norm_messages = [
        {"role": str(m.get("role", "user")), "content": str(m.get("content", ""))}
        for m in messages
        if isinstance(m, dict)
    ]

    def sse_chunks() -> Iterator[str]:
        full = ""
        try:
            for piece in backend.stream_chat(
                norm_messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
            ):
                full += piece
                if stream:
                    payload = {
                        "choices": [{"delta": {"content": piece}, "index": 0}],
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
        except Exception as e:
            err = {"error": {"message": str(e), "type": "sidecar_error"}}
            yield f"data: {json.dumps(err)}\n\n"
        if stream:
            yield "data: [DONE]\n\n"
        else:
            payload = {
                "choices": [{"message": {"role": "assistant", "content": full}, "index": 0}],
            }
            yield json.dumps(payload)

    if stream:
        return StreamingResponse(sse_chunks(), media_type="text/event-stream")
    return StreamingResponse(sse_chunks(), media_type="application/json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning")
    server = uvicorn.Server(config)
    # Print bound port for parent process when port=0
    import asyncio

    async def run() -> None:
        await server.serve()

    if args.port == 0:
        import socket

        sock = socket.socket()
        sock.bind((args.host, 0))
        port = sock.getsockname()[1]
        sock.close()
        print(f"OMEGA_SIDECAR_PORT={port}", flush=True)
        config.port = port
    uvicorn.run(app, host=args.host, port=config.port, log_level="warning")


if __name__ == "__main__":
    main()
