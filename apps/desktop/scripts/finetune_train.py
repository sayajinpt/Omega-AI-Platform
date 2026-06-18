#!/usr/bin/env python3
"""
Omega fine-tuning worker. Reads job config JSON, emits progress lines:
  {"type":"progress","percent":N,"message":"..."}
  {"type":"log","line":"..."}
  {"type":"done","adapterPath":"..."}
  {"type":"error","message":"..."}
"""
from __future__ import annotations

import json
import sys
import os
from pathlib import Path


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def train_llm_lora(cfg: dict) -> None:
    model_path = cfg["modelPath"]
    train_path = cfg["dataset"]["trainPath"]
    out_dir = cfg["outputDir"]
    hp = cfg["hyperparams"]
    modality = cfg["modality"]

    emit({"type": "log", "line": f"Loading training data from {train_path}"})

    try:
        from unsloth import FastLanguageModel  # type: ignore
        emit({"type": "progress", "percent": 20, "message": "Loading model with Unsloth…"})
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=model_path,
            max_seq_length=int(hp.get("maxSeqLength", 2048)),
            load_in_4bit=True,
        )
        model = FastLanguageModel.get_peft_model(
            model,
            r=int(hp.get("loraRank", 16)),
            lora_alpha=int(hp.get("loraAlpha", 32)),
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        )
        from datasets import load_dataset  # type: ignore
        from trl import SFTTrainer  # type: ignore
        from transformers import TrainingArguments  # type: ignore

        ds = load_dataset("json", data_files=train_path, split="train")

        def format_row(examples):
            texts = []
            for i in range(len(examples[next(iter(examples))])):
                row = {k: examples[k][i] for k in examples}
                if "messages" in row:
                    texts.append(
                        tokenizer.apply_chat_template(row["messages"], tokenize=False)
                    )
                elif "instruction" in row:
                    inst, inp, out = row.get("instruction", ""), row.get("input", ""), row.get("output", "")
                    user = f"{inst}\n{inp}".strip() if inp else inst
                    texts.append(
                        f"<|user|>\n{user}\n<|assistant|>\n{out}"
                    )
                else:
                    texts.append(str(row))
            return {"text": texts}

        ds = ds.map(format_row, batched=True, remove_columns=ds.column_names)
        emit({"type": "progress", "percent": 40, "message": "Starting SFT training…"})

        args = TrainingArguments(
            output_dir=out_dir,
            per_device_train_batch_size=int(hp.get("batchSize", 2)),
            gradient_accumulation_steps=int(hp.get("gradientAccumulation", 4)),
            num_train_epochs=float(hp.get("epochs", 2)),
            learning_rate=float(hp.get("learningRate", 2e-4)),
            logging_steps=10,
            save_steps=int(hp.get("saveSteps", 100)),
            warmup_ratio=float(hp.get("warmupRatio", 0.05)),
            fp16=not __import__("torch").cuda.is_bf16_supported(),
            bf16=__import__("torch").cuda.is_bf16_supported(),
            report_to="none",
        )
        trainer = SFTTrainer(model=model, tokenizer=tokenizer, train_dataset=ds, args=args)
        trainer.train()
        adapter = os.path.join(out_dir, "lora_adapter")
        model.save_pretrained(adapter)
        tokenizer.save_pretrained(adapter)
        emit({"type": "done", "adapterPath": adapter, "percent": 100, "message": "Training complete"})
        return
    except ImportError as e:
        emit({"type": "log", "line": f"Unsloth not available ({e}), trying PEFT…"})

    try:
        import torch  # type: ignore
        from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments  # type: ignore
        from peft import LoraConfig, get_peft_model  # type: ignore
        from datasets import load_dataset  # type: ignore
        from trl import SFTTrainer  # type: ignore

        emit({"type": "progress", "percent": 25, "message": "Loading with PEFT + Transformers…"})
        tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            model_path, torch_dtype=torch.float16, device_map="auto", trust_remote_code=True
        )
        peft_cfg = LoraConfig(
            r=int(hp.get("loraRank", 16)),
            lora_alpha=int(hp.get("loraAlpha", 32)),
            target_modules=["q_proj", "v_proj"],
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, peft_cfg)
        ds = load_dataset("json", data_files=train_path, split="train")

        def tok_map(batch):
            texts = []
            for i in range(len(batch[list(batch.keys())[0]])):
                row = {k: batch[k][i] for k in batch}
                if "messages" in row:
                    texts.append(tokenizer.apply_chat_template(row["messages"], tokenize=False))
                else:
                    texts.append(
                        f"### Instruction:\n{row.get('instruction','')}\n### Response:\n{row.get('output','')}"
                    )
            return tokenizer(texts, truncation=True, max_length=int(hp.get("maxSeqLength", 2048)))

        ds = ds.map(tok_map, batched=True)
        args = TrainingArguments(
            output_dir=out_dir,
            per_device_train_batch_size=int(hp.get("batchSize", 1)),
            num_train_epochs=float(hp.get("epochs", 1)),
            learning_rate=float(hp.get("learningRate", 2e-4)),
            logging_steps=10,
            save_steps=int(hp.get("saveSteps", 100)),
            report_to="none",
        )
        trainer = SFTTrainer(model=model, args=args, train_dataset=ds, tokenizer=tokenizer)
        trainer.train()
        adapter = os.path.join(out_dir, "lora_adapter")
        model.save_pretrained(adapter)
        tokenizer.save_pretrained(adapter)
        emit({"type": "done", "adapterPath": adapter, "percent": 100, "message": "PEFT training complete"})
    except ImportError as e:
        emit({
            "type": "error",
            "message": "Install training deps: pip install unsloth OR pip install torch transformers peft trl datasets",
        })
        raise SystemExit(1) from e


def prepare_only(cfg: dict) -> None:
    emit({"type": "progress", "percent": 100, "message": "Dataset prepared (training backend not available for this modality)"})
    emit({
        "type": "done",
        "adapterPath": cfg["outputDir"],
        "message": "Export-only job finished. Install modality-specific trainers for full runs.",
    })


def main() -> None:
    if len(sys.argv) < 2:
        emit({"type": "error", "message": "Usage: finetune_train.py <job-config.json>"})
        sys.exit(1)
    cfg_path = Path(sys.argv[1])
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    modality = cfg.get("modality", "instruction")
    dry = cfg.get("dryRun", False)
    backend = cfg.get("trainerBackend", "unsloth")

    if dry:
        emit({"type": "progress", "percent": 100, "message": "Dry run — config validated"})
        emit({"type": "done", "message": "Dry run OK", "adapterPath": cfg["outputDir"]})
        return

    if modality in ("text_to_image", "embedding") or backend == "prepare-only":
        prepare_only(cfg)
        return

    if modality in ("instruction", "conversational", "chatml", "alpaca", "completion", "image_to_text"):
        train_llm_lora(cfg)
        return

    emit({"type": "error", "message": f"Unsupported modality: {modality}"})
    sys.exit(1)


if __name__ == "__main__":
    main()
