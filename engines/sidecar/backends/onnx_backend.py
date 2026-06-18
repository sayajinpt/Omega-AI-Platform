"""ONNX chat — routes GenAI packs vs onnx-community hybrid exports."""
from __future__ import annotations

from typing import Iterator

from backends.onnx_community_backend import OnnxCommunityHybridBackend
from backends.onnx_genai_core import OnnxGenaiCoreBackend
from backends.onnx_prepare import detect_onnx_runtime


class OnnxGenaiBackend:
    """Sidecar ONNX backend (GenAI or direct ORT for community hybrid models)."""

    def __init__(self) -> None:
        self._impl: OnnxGenaiCoreBackend | OnnxCommunityHybridBackend | None = None
        self._mode: str | None = None

    @staticmethod
    def available() -> bool:
        return OnnxGenaiCoreBackend.available() or OnnxCommunityHybridBackend.available()

    def load(self, model_path: str) -> None:
        self.unload()
        runtime = detect_onnx_runtime(model_path)
        if runtime == "community_hybrid":
            if not OnnxCommunityHybridBackend.available():
                raise RuntimeError(
                    "onnx-community hybrid models need onnxruntime and transformers in the sidecar venv"
                )
            self._impl = OnnxCommunityHybridBackend()
            self._mode = "community_hybrid"
        else:
            if not OnnxGenaiCoreBackend.available():
                raise RuntimeError("onnxruntime-genai not installed")
            self._impl = OnnxGenaiCoreBackend()
            self._mode = "genai"
        self._impl.load(model_path)

    def unload(self) -> None:
        if self._impl:
            self._impl.unload()
        self._impl = None
        self._mode = None

    @property
    def path(self) -> str | None:
        return self._impl.path if self._impl else None

    def stream_chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        top_p: float = 0.9,
        max_tokens: int = 512,
    ) -> Iterator[str]:
        if not self._impl:
            raise RuntimeError("ONNX model not loaded")
        yield from self._impl.stream_chat(
            messages,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        )


def messages_to_template_json(messages: list[dict[str, str]]) -> str:
    from backends.onnx_genai_core import messages_to_template_json as _fn

    return _fn(messages)
