"""Prepare onnx-community / missing-genai_config packs for ONNX sidecar inference."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

OnnxRuntimeKind = Literal["genai", "community_hybrid"]

_PREFERRED_ONNX = (
    "model_q4f16.onnx",
    "model_q4.onnx",
    "model_quantized.onnx",
    "model_fp16.onnx",
    "model.onnx",
)


class OnnxPrepareError(RuntimeError):
    """Model directory cannot be loaded by the ONNX sidecar."""


def find_primary_onnx(root: Path, *, search_root: Path | None = None) -> Path | None:
    base = search_root or root
    onnx_files = [
        p
        for p in base.rglob("*.onnx")
        if p.is_file() and not re.search(r"\.onnx[._]data", p.name, re.I)
    ]
    if not onnx_files:
        return None
    prefer_lower = [n.lower() for n in _PREFERRED_ONNX]
    for prefer in prefer_lower:
        for path in onnx_files:
            if path.name.lower() == prefer:
                return path
    return min(onnx_files, key=lambda p: p.stat().st_size)


def _score_genai_pack(path: Path) -> tuple[int, int]:
    s = path.as_posix().lower()
    rank = 0
    if "cpu" in s:
        rank += 100
    if "int4" in s:
        rank += 50
    if "mobile" in s:
        rank += 25
    if "gpu" in s or "cuda" in s:
        rank -= 30
    return (rank, -len(path.parts))


def find_genai_config(root: Path) -> Path | None:
    candidates = [p for p in root.rglob("genai_config.json") if p.is_file()]
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    return max(candidates, key=_score_genai_pack)


def resolve_genai_root(root: Path) -> Path:
    cfg = find_genai_config(root)
    if cfg is not None:
        return cfg.parent
    return root


def read_hf_config(root: Path) -> dict[str, Any]:
    cfg_path = root / "config.json"
    if not cfg_path.is_file():
        return {}
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise OnnxPrepareError(f"Invalid config.json under {root}: {e}") from e
    return data if isinstance(data, dict) else {}


def onnx_input_names(onnx_path: Path) -> list[str]:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    return [i.name for i in sess.get_inputs()]


def onnx_output_names(onnx_path: Path) -> list[str]:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    return [o.name for o in sess.get_outputs()]


def is_community_hybrid_layout(onnx_inputs: list[str], hf_cfg: dict[str, Any]) -> bool:
    has_short_conv = any(n.startswith("past_conv.") for n in onnx_inputs)
    has_short_recurrent = any(n.startswith("past_recurrent.") for n in onnx_inputs)
    has_official_conv = any(".conv_state" in n for n in onnx_inputs)
    layer_types = hf_cfg.get("layer_types") or []
    model_type = str(hf_cfg.get("model_type") or "").lower()
    arch = str((hf_cfg.get("architectures") or [""])[0]).lower()
    hybrid = (
        "linear_attention" in layer_types
        or model_type in {"qwen3_5_text", "qwen3_5"}
        or "qwen3_5" in arch
    )
    return hybrid and has_short_recurrent and has_short_conv and not has_official_conv


def detect_onnx_runtime(model_path: str) -> OnnxRuntimeKind:
    root = Path(model_path).resolve()
    if not root.is_dir():
        raise OnnxPrepareError(f"ONNX model path is not a directory: {root}")
    pack = resolve_genai_root(root)
    primary_onnx = find_primary_onnx(root, search_root=pack if pack != root else None)
    if primary_onnx is None:
        primary_onnx = find_primary_onnx(root)
    if primary_onnx is None:
        raise OnnxPrepareError(f"No .onnx decoder found under {root}")
    hf_cfg = read_hf_config(pack)
    if not hf_cfg:
        hf_cfg = read_hf_config(root)
    inputs = onnx_input_names(primary_onnx)
    if is_community_hybrid_layout(inputs, hf_cfg):
        return "community_hybrid"
    return "genai"


def ensure_genai_config(model_path: str) -> Path:
    """Ensure ``genai_config.json`` exists for onnxruntime-genai packs."""
    root = Path(model_path).resolve()
    if detect_onnx_runtime(model_path) == "community_hybrid":
        raise OnnxPrepareError("community hybrid models do not use genai_config.json")

    pack = resolve_genai_root(root)
    cfg_path = pack / "genai_config.json"
    hf_cfg = read_hf_config(pack)
    if not hf_cfg:
        hf_cfg = read_hf_config(root)
    primary_onnx = find_primary_onnx(root, search_root=pack)
    if primary_onnx is None:
        raise OnnxPrepareError(f"No .onnx decoder found under {root}")

    onnx_inputs = onnx_input_names(primary_onnx)
    onnx_outputs = onnx_output_names(primary_onnx)

    if not cfg_path.is_file():
        genai_cfg = _synthesize_genai_config(pack, hf_cfg, primary_onnx, onnx_inputs, onnx_outputs)
        cfg_path.write_text(json.dumps(genai_cfg, indent=2) + "\n", encoding="utf-8")
    else:
        genai_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    _validate_genai_paths(pack, genai_cfg)
    return cfg_path


def _infer_model_type(hf_cfg: dict[str, Any]) -> str:
    model_type = str(hf_cfg.get("model_type") or "").strip()
    if model_type:
        return model_type.lower()
    arch = str((hf_cfg.get("architectures") or ["decoder"])[0])
    if "For" in arch:
        return arch[: arch.index("For")].lower()
    return "decoder"


def _token_id(hf_cfg: dict[str, Any], key: str, default: int | None = None) -> int | None:
    val = hf_cfg.get(key, default)
    if isinstance(val, list):
        return int(val[0]) if val else default
    if val is None:
        return default
    return int(val)


def _context_length(hf_cfg: dict[str, Any]) -> int:
    for key in ("context_length", "max_position_embeddings", "max_seq_len"):
        val = hf_cfg.get(key)
        if isinstance(val, int) and val > 0:
            return min(val, 131072)
    return 8192


def _head_size(hf_cfg: dict[str, Any]) -> int:
    if isinstance(hf_cfg.get("head_dim"), int):
        return int(hf_cfg["head_dim"])
    hidden = int(hf_cfg.get("hidden_size") or 0)
    heads = int(hf_cfg.get("num_attention_heads") or 0)
    if hidden > 0 and heads > 0:
        return hidden // heads
    return 128


def _build_inputs(onnx_inputs: list[str]) -> dict[str, str]:
    inputs: dict[str, str] = {}
    if "input_ids" in onnx_inputs:
        inputs["input_ids"] = "input_ids"
    if "inputs_embeds" in onnx_inputs:
        inputs["inputs_embeds"] = "inputs_embeds"
    if "attention_mask" in onnx_inputs:
        inputs["attention_mask"] = "attention_mask"
    if "position_ids" in onnx_inputs:
        inputs["position_ids"] = "position_ids"
    if any(n.endswith(".key") and n.startswith("past_key_values.") for n in onnx_inputs):
        inputs["past_key_names"] = "past_key_values.%d.key"
        inputs["past_value_names"] = "past_key_values.%d.value"
    if any(n.startswith("past_conv.") for n in onnx_inputs):
        inputs["past_conv_names"] = "past_conv.%d"
    if "past_sequence_length" in onnx_inputs:
        inputs["past_sequence_length"] = "past_sequence_length"
    return inputs


def _build_outputs(onnx_outputs: list[str]) -> dict[str, str]:
    outputs: dict[str, str] = {"logits": "logits"}
    if any(".key" in n and n.startswith("present.") for n in onnx_outputs):
        outputs["present_key_names"] = "present.%d.key"
        outputs["present_value_names"] = "present.%d.value"
    if any(n.startswith("present_conv.") for n in onnx_outputs):
        outputs["present_conv_names"] = "present_conv.%d"
    if any(n.startswith("present_recurrent.") for n in onnx_outputs):
        outputs["rnn_states"] = "present_recurrent.%d"
    return outputs


def _synthesize_genai_config(
    root: Path,
    hf_cfg: dict[str, Any],
    primary_onnx: Path,
    onnx_inputs: list[str],
    onnx_outputs: list[str],
) -> dict[str, Any]:
    rel_onnx = primary_onnx.relative_to(root).as_posix()
    layer_types = hf_cfg.get("layer_types")
    if not isinstance(layer_types, list):
        layer_types = None

    bos = _token_id(hf_cfg, "bos_token_id", 1)
    eos = _token_id(hf_cfg, "eos_token_id")
    pad = _token_id(hf_cfg, "pad_token_id", eos if eos is not None else 0)

    decoder: dict[str, Any] = {
        "filename": rel_onnx,
        "head_size": _head_size(hf_cfg),
        "hidden_size": int(hf_cfg.get("hidden_size") or 0),
        "num_attention_heads": int(hf_cfg.get("num_attention_heads") or 0),
        "num_key_value_heads": int(hf_cfg.get("num_key_value_heads") or 0),
        "num_hidden_layers": int(hf_cfg.get("num_hidden_layers") or 0),
        "session_options": {"log_id": "onnxruntime-genai", "provider_options": []},
        "inputs": _build_inputs(onnx_inputs),
        "outputs": _build_outputs(onnx_outputs),
    }
    if layer_types:
        decoder["layer_types"] = layer_types

    return {
        "model": {
            "type": _infer_model_type(hf_cfg),
            "bos_token_id": bos,
            "eos_token_id": eos,
            "pad_token_id": pad,
            "vocab_size": int(hf_cfg.get("vocab_size") or 0),
            "context_length": _context_length(hf_cfg),
            "decoder": decoder,
        },
        "search": {
            "do_sample": False,
            "max_length": _context_length(hf_cfg),
            "past_present_share_buffer": False,
            "top_k": 1,
            "top_p": 1.0,
            "temperature": 1.0,
            "num_beams": 1,
            "num_return_sequences": 1,
            "early_stopping": True,
            "length_penalty": 1.0,
            "repetition_penalty": 1.0,
            "diversity_penalty": 0.0,
            "min_length": 0,
            "no_repeat_ngram_size": 0,
        },
    }


def _validate_genai_paths(root: Path, genai_cfg: dict[str, Any]) -> None:
    decoder = (genai_cfg.get("model") or {}).get("decoder") or {}
    rel = str(decoder.get("filename") or "").strip()
    if rel and not (root / rel).is_file():
        raise OnnxPrepareError(
            f"genai_config.json points to missing decoder ONNX: {rel} (under {root})"
        )
