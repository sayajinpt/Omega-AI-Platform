"""ExLlamaV2 / EXL2 inference — https://github.com/turboderp-org/exllamav2"""
from __future__ import annotations

from typing import Any, Iterator


class Exl2Backend:
    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._cache = None
        self._generator = None
        self._path: str | None = None

    @staticmethod
    def available() -> bool:
        try:
            import exllamav2  # noqa: F401

            return True
        except ImportError:
            return False

    def load(self, model_path: str, max_seq_len: int = 8192) -> None:
        from exllamav2 import ExLlamaV2, ExLlamaV2Cache, ExLlamaV2Config, ExLlamaV2Tokenizer
        from exllamav2.generator import ExLlamaV2Sampler, ExLlamaV2StreamingGenerator

        self.unload()
        config = ExLlamaV2Config(model_path)
        if max_seq_len > 0:
            config.max_seq_len = max_seq_len
        self._model = ExLlamaV2(config)
        self._model.load()
        self._tokenizer = ExLlamaV2Tokenizer(config)
        self._cache = ExLlamaV2Cache(self._model, max_seq_len=config.max_seq_len)
        self._generator = ExLlamaV2StreamingGenerator(self._model, self._cache, self._tokenizer)
        self._sampler_cls = ExLlamaV2Sampler
        self._path = model_path

    def unload(self) -> None:
        self._model = None
        self._tokenizer = None
        self._cache = None
        self._generator = None
        self._path = None

    @property
    def path(self) -> str | None:
        return self._path

    def stream_chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        top_p: float = 0.9,
        max_tokens: int = 512,
    ) -> Iterator[str]:
        if not self._generator or not self._tokenizer:
            raise RuntimeError("EXL2 model not loaded")

        prompt = _messages_to_prompt(messages)
        ids = self._tokenizer.encode(prompt, add_bos=True)
        settings = self._sampler_cls.Settings()
        settings.temperature = temperature
        settings.top_p = top_p
        settings.top_k = 0
        sampler = self._sampler_cls(settings)
        self._generator.begin_stream(ids, sampler)
        emitted = 0
        while emitted < max_tokens:
            chunk = self._generator.stream()
            if chunk is None:
                break
            text = self._tokenizer.decode(chunk) if hasattr(self._tokenizer, "decode") else str(chunk)
            if text:
                emitted += 1
                yield text
        self._generator.end_stream()


def _messages_to_prompt(messages: list[dict[str, str]]) -> str:
    parts: list[str] = []
    for m in messages:
        role = (m.get("role") or "user").lower()
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            parts.append(f"### System:\n{content}\n")
        elif role == "assistant":
            parts.append(f"### Assistant:\n{content}\n")
        else:
            parts.append(f"### User:\n{content}\n")
    parts.append("### Assistant:\n")
    return "\n".join(parts)
