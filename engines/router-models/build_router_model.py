#!/usr/bin/env python3
"""
Download Qwen3 embed/rerank from HuggingFace, export ONNX, quantize INT8, deploy to Omega router_models/.

Progress lines: OMEGA_ROUTER_PROGRESS:{"phase":"...","detail":"...","percent":N}
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ROLE_CONFIG = {
    "embedding": {
        "model_id": "Qwen/Qwen3-Embedding-0.6B",
        "kind": "feature",
    },
    "reranker": {
        "model_id": "Qwen/Qwen3-Reranker-0.6B",
        "kind": "sequence_classification",
    },
}


def progress(phase: str, detail: str, percent: int | None = None) -> None:
    payload: dict[str, object] = {"phase": phase, "detail": detail}
    if percent is not None:
        payload["percent"] = percent
    print(f"OMEGA_ROUTER_PROGRESS:{json.dumps(payload)}", flush=True)


def cleanup_work_tree(work: Path) -> None:
    """Remove HF cache, full-precision ONNX, and INT8 scratch — only deploy-dir is kept."""
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)


def deploy_int8_only(int8_dir: Path, deploy: Path) -> None:
    """Copy tokenizer + quantized ONNX into the final router_models role folder."""
    if deploy.exists():
        shutil.rmtree(deploy)
    deploy.mkdir(parents=True, exist_ok=True)
    for item in int8_dir.iterdir():
        dest = deploy / item.name
        if item.is_dir():
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Omega smart-input router ONNX model")
    parser.add_argument("--role", required=True, choices=sorted(ROLE_CONFIG.keys()))
    parser.add_argument("--work-dir", required=True, help="Scratch dir (hf cache, onnx, int8)")
    parser.add_argument("--deploy-dir", required=True, help="Final router_models/{embedding|reranker}")
    args = parser.parse_args()

    cfg = ROLE_CONFIG[args.role]
    work = Path(args.work_dir)
    deploy = Path(args.deploy_dir)
    hf_dir = work / "hf_cache"
    onnx_dir = work / "onnx"
    int8_dir = work / "int8"

    token = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or "").strip()
    if token:
        os.environ["HF_TOKEN"] = token
        os.environ["HUGGINGFACE_HUB_TOKEN"] = token

    # Keep all Hugging Face / Transformers downloads inside the scratch tree.
    os.environ["HF_HOME"] = str(work / "hf_home")
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hf_dir)
    os.environ["TRANSFORMERS_CACHE"] = str(hf_dir)

    try:
        if work.exists():
            cleanup_work_tree(work)
        work.mkdir(parents=True, exist_ok=True)
        progress("starting", f"Preparing {cfg['model_id']}", 2)

        from transformers import AutoTokenizer
        from optimum.onnxruntime import ORTQuantizer
        from optimum.onnxruntime.configuration import AutoQuantizationConfig

        if cfg["kind"] == "feature":
            from optimum.onnxruntime import ORTModelForFeatureExtraction as ModelCls
        else:
            from optimum.onnxruntime import ORTModelForSequenceClassification as ModelCls

        progress("download", f"Downloading {cfg['model_id']} from Hugging Face", 8)
        tokenizer = AutoTokenizer.from_pretrained(cfg["model_id"], cache_dir=str(hf_dir))

        progress("export", "Exporting model to ONNX (Optimum)", 28)
        model = ModelCls.from_pretrained(cfg["model_id"], export=True, cache_dir=str(hf_dir))
        onnx_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(onnx_dir)
        tokenizer.save_pretrained(onnx_dir)

        progress("quantize", "Quantizing ONNX to INT8", 58)
        quantizer = ORTQuantizer.from_pretrained(onnx_dir)
        qconfig = AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=False)
        if int8_dir.exists():
            shutil.rmtree(int8_dir)
        int8_dir.mkdir(parents=True, exist_ok=True)
        quantizer.quantize(save_dir=int8_dir, quantization_config=qconfig)

        onnx_files = list(int8_dir.glob("*.onnx"))
        if not onnx_files:
            raise RuntimeError(f"No .onnx file produced in {int8_dir}")

        progress("deploy", f"Deploying INT8 ONNX to {deploy}", 88)
        deploy_int8_only(int8_dir, deploy)

        progress("cleanup", "Removing downloads and intermediate ONNX (~1.2 GB freed)", 95)
        cleanup_work_tree(work)

        progress("done", f"{args.role} router model deployed (~600 MB INT8 only)", 100)
        return 0
    except Exception as exc:  # noqa: BLE001
        progress("error", str(exc))
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
