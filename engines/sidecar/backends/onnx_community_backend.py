"""ONNX Runtime inference for onnx-community / transformers.js hybrid exports."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import numpy as np

from backends.onnx_prepare import OnnxPrepareError, find_primary_onnx, read_hf_config


class OnnxCommunityHybridBackend:
    """Runs past_conv / past_recurrent hybrid models via raw ONNX Runtime sessions."""

    def __init__(self) -> None:
        self._session = None
        self._tokenizer = None
        self._path: str | None = None
        self._onnx_path: Path | None = None
        self._input_meta: dict[str, Any] = {}
        self._output_names: list[str] = []
        self._present_to_past: dict[str, str] = {}
        self._eos_ids: set[int] = set()

    @staticmethod
    def available() -> bool:
        try:
            import onnxruntime  # noqa: F401
            from transformers import PreTrainedTokenizerFast  # noqa: F401

            return True
        except ImportError:
            return False

    def load(self, model_path: str) -> None:
        import onnxruntime as ort
        from transformers import PreTrainedTokenizerFast

        self.unload()
        root = Path(model_path).resolve()
        if not root.is_dir():
            raise OnnxPrepareError(f"ONNX model path is not a directory: {root}")

        onnx_path = find_primary_onnx(root)
        if onnx_path is None:
            raise OnnxPrepareError(f"No .onnx decoder found under {root}")

        tok_path = root / "tokenizer.json"
        if not tok_path.is_file():
            raise OnnxPrepareError(f"Missing tokenizer.json under {root}")

        providers = ort.get_available_providers()
        use_providers = []
        if "CUDAExecutionProvider" in providers:
            use_providers.append("CUDAExecutionProvider")
        use_providers.append("CPUExecutionProvider")

        self._session = ort.InferenceSession(str(onnx_path), providers=use_providers)
        self._input_meta = {i.name: i for i in self._session.get_inputs()}
        self._output_names = [o.name for o in self._session.get_outputs()]
        self._present_to_past = _build_present_to_past(self._output_names)

        self._tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(tok_path))
        chat_tpl = root / "chat_template.jinja"
        if chat_tpl.is_file():
            self._tokenizer.chat_template = chat_tpl.read_text(encoding="utf-8")

        hf_cfg = read_hf_config(root)
        eos = hf_cfg.get("eos_token_id")
        if isinstance(eos, list):
            self._eos_ids = {int(x) for x in eos}
        elif isinstance(eos, int):
            self._eos_ids = {eos}
        gen_cfg_path = root / "generation_config.json"
        if gen_cfg_path.is_file():
            try:
                gen_cfg = json.loads(gen_cfg_path.read_text(encoding="utf-8"))
                gen_eos = gen_cfg.get("eos_token_id")
                if isinstance(gen_eos, list):
                    self._eos_ids.update(int(x) for x in gen_eos)
                elif isinstance(gen_eos, int):
                    self._eos_ids.add(int(gen_eos))
            except json.JSONDecodeError:
                pass

        self._path = str(root)
        self._onnx_path = onnx_path

    def unload(self) -> None:
        self._session = None
        self._tokenizer = None
        self._path = None
        self._onnx_path = None
        self._input_meta = {}
        self._output_names = []
        self._present_to_past = {}
        self._eos_ids = set()

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
        if not self._session or not self._tokenizer:
            raise RuntimeError("ONNX community model not loaded")

        prompt = _render_prompt(self._tokenizer, messages)
        input_ids = self._tokenizer.encode(prompt, add_special_tokens=False)
        if not input_ids:
            return

        state: dict[str, np.ndarray] = {}
        generated: list[int] = list(input_ids)
        prefix_len = len(input_ids)

        for _ in range(max_tokens):
            step_ids = generated if len(generated) == prefix_len else [generated[-1]]
            feed = self._build_feed(step_ids, len(generated), state)
            outputs = self._session.run(self._output_names, feed)
            for idx, name in enumerate(self._output_names):
                past_name = self._present_to_past.get(name)
                if past_name:
                    state[past_name] = outputs[idx]

            logits = outputs[self._output_names.index("logits")][0, -1].astype(np.float32)
            next_id = _sample_token(logits, temperature=temperature, top_p=top_p)
            generated.append(next_id)

            if next_id in self._eos_ids:
                break

            piece = self._tokenizer.decode([next_id], skip_special_tokens=True)
            if piece:
                yield piece

    def _build_feed(
        self,
        input_ids: list[int],
        total_len: int,
        state: dict[str, np.ndarray],
    ) -> dict[str, np.ndarray]:
        feed: dict[str, np.ndarray] = {}
        for name, meta in self._input_meta.items():
            if name in ("input_ids", "attention_mask", "num_logits_to_keep"):
                continue
            feed[name] = state.get(name, _zeros_for(meta))

        feed["input_ids"] = np.array([input_ids], dtype=np.int64)
        feed["attention_mask"] = np.ones((1, total_len), dtype=np.int64)
        feed["num_logits_to_keep"] = np.array(1, dtype=np.int64)
        return feed


def _build_present_to_past(output_names: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for name in output_names:
        if name.startswith("present_conv."):
            mapping[name] = name.replace("present_conv.", "past_conv.", 1)
        elif name.startswith("present_recurrent."):
            mapping[name] = name.replace("present_recurrent.", "past_recurrent.", 1)
        elif name.startswith("present.") and name.endswith(".key"):
            mapping[name] = name.replace("present.", "past_key_values.", 1)
        elif name.startswith("present.") and name.endswith(".value"):
            mapping[name] = name.replace("present.", "past_key_values.", 1)
    return mapping


def _ort_dtype(type_str: str) -> np.dtype:
    mapping = {
        "tensor(float16)": np.float16,
        "tensor(float)": np.float32,
        "tensor(int64)": np.int64,
        "tensor(int32)": np.int32,
    }
    return mapping.get(type_str, np.float32)


def _zeros_for(meta: Any) -> np.ndarray:
    shape: list[int] = []
    for dim in meta.shape:
        if dim in ("batch_size", None, ""):
            shape.append(1)
        elif dim in ("past_sequence_length", "total_sequence_length", "sequence_length"):
            shape.append(0)
        else:
            try:
                shape.append(int(dim))
            except (TypeError, ValueError):
                shape.append(1)
    return np.zeros(shape, dtype=_ort_dtype(meta.type))


def _render_prompt(tokenizer: Any, messages: list[dict[str, str]]) -> str:
    norm = [{"role": str(m.get("role", "user")), "content": str(m.get("content", ""))} for m in messages]
    if getattr(tokenizer, "chat_template", None):
        try:
            return tokenizer.apply_chat_template(norm, tokenize=False, add_generation_prompt=True)
        except Exception:
            pass
    lines: list[str] = []
    for m in norm:
        role = m["role"].capitalize()
        content = m["content"].strip()
        if content:
            lines.append(f"{role}: {content}")
    lines.append("Assistant:")
    return "\n".join(lines)


def _sample_token(logits: np.ndarray, *, temperature: float, top_p: float) -> int:
    if temperature <= 1e-5:
        return int(np.argmax(logits))

    scaled = logits / max(temperature, 1e-5)
    scaled -= np.max(scaled)
    probs = np.exp(scaled)
    probs /= np.sum(probs)

    if top_p < 1.0:
        order = np.argsort(probs)[::-1]
        cumulative = 0.0
        keep: list[int] = []
        for idx in order:
            keep.append(int(idx))
            cumulative += float(probs[idx])
            if cumulative >= top_p:
                break
        mask = np.zeros_like(probs)
        mask[keep] = probs[keep]
        total = mask.sum()
        if total > 0:
            probs = mask / total

    return int(np.random.choice(len(probs), p=probs))
