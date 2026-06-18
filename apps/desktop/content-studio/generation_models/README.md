# Local TTS & image models (`localgen` package)

Install editable from the repo root (`youtube_automation`) **or** from `backend/` — relative paths differ:

```powershell
cd C:\path\to\youtube_automation
pip install -e ./generation_models
pip install -e "./generation_models[tts,image]"   # torch, qwen-tts, diffusers, sentencepiece (SD3 tokenizer), …
pip install -e "./generation_models[gui]"        # PyQt6 for the standalone studio

# If your shell is already in backend\ instead:
pip install -e "../generation_models[tts,image]"
```

**Windows:** From `youtube_automation`, use `./generation_models`, **not** `../generation_models` (that points outside the repo and pip will error).

- **Desktop studio**: run `run_qwen_tts_gui.bat` (or `python qwen_tts_gui.py` from this folder).
- **Headless API**: `from localgen.downloads import download_snapshot` and `from localgen.engines import synthesize_qwen_wav, load_sd3_pipeline, generate_image_file`.

**Weights vs Python:** putting models under `D:\models\tts` and `D:\models\image` is required but **not sufficient**. The same machine must also `pip install` the **torch / qwen-tts / diffusers** stack into **`backend\.venv`** (the interpreter that runs the desktop app). Use `run-project.bat` (installs `[tts,image]` extras) or manually: from `backend\`, `pip install -e "../generation_models[tts,image]"`.
