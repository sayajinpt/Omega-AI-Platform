"""Standard onnxruntime-genai chat backend."""
from __future__ import annotations

from pathlib import Path
from typing import Iterator

from backends.onnx_prepare import ensure_genai_config, resolve_genai_root


def messages_to_template_json(messages: list[dict[str, str]]) -> str:
    import json

    return json.dumps(
        [{"role": m.get("role", "user"), "content": m.get("content", "")} for m in messages]
    )


class OnnxGenaiCoreBackend:
    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._path: str | None = None

    @staticmethod
    def available() -> bool:
        try:
            import onnxruntime_genai  # noqa: F401

            return True
        except ImportError:
            return False

    def load(self, model_path: str) -> None:
        import onnxruntime_genai as og

        self.unload()
        root = Path(model_path).resolve()
        pack = resolve_genai_root(root)
        ensure_genai_config(model_path)
        self._model = og.Model(str(pack))
        self._tokenizer = og.Tokenizer(self._model)
        self._path = str(pack)

    def unload(self) -> None:
        self._model = None
        self._tokenizer = None
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
        import onnxruntime_genai as og

        if not self._model or not self._tokenizer:
            raise RuntimeError("ONNX GenAI model not loaded")

        prompt = _messages_to_prompt(messages)
        try:
            prompt = self._tokenizer.apply_chat_template(
                messages_to_template_json(messages),
                add_generation_prompt=True,
            )
        except Exception:
            pass

        input_ids = self._tokenizer.encode(prompt)
        params = og.GeneratorParams(self._model)
        params.set_search_options(temperature=temperature, top_p=top_p, max_length=max_tokens)
        generator = og.Generator(self._model, params)
        generator.append_tokens(input_ids)
        while not generator.is_done():
            generator.generate_next_token()
            token = generator.get_next_tokens()
            if token is None:
                break
            try:
                text = self._tokenizer.decode(token)
            except Exception:
                text = ""
            if text:
                yield text


def _messages_to_prompt(messages: list[dict[str, str]]) -> str:
    lines: list[str] = []
    for m in messages:
        role = (m.get("role") or "user").capitalize()
        content = (m.get("content") or "").strip()
        if content:
            lines.append(f"{role}: {content}")
    lines.append("Assistant:")
    return "\n".join(lines)
