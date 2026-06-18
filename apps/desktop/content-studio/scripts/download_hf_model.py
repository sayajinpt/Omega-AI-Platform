"""Download a full Hugging Face repo snapshot for Content Studio (TTS / image weights)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["tts", "image", "video", "image_adapter"])
    parser.add_argument("repo_id")
    parser.add_argument("models_root")
    parser.add_argument("--label", default="")
    args = parser.parse_args()

    root = Path(args.models_root).expanduser().resolve()
    repo_id = args.repo_id.strip()
    if not repo_id:
        print("repo_id is required", file=sys.stderr)
        return 1

    from localgen.downloads import download_snapshot, snapshot_ready
    from localgen.hf_auth import hf_token_argument
    from localgen.installed_models import register_installed_model, repo_snapshot_dir

    # Content Studio desktop UI may store a token; Omega also sets HF_TOKEN in the spawn env.
    try:
        from app.desktop.desktop_models_settings import apply_saved_hf_token_to_environ

        apply_saved_hf_token_to_environ()
    except ImportError:
        pass

    if args.kind == "image_adapter":
        safe = repo_id.replace("/", "__")
        dest = root / "image-adapters" / safe
    else:
        dest = repo_snapshot_dir(root, args.kind, repo_id)
    print(f"Downloading {repo_id} → {dest}", file=sys.stderr, flush=True)
    if not hf_token_argument():
        print(
            "No Hugging Face token in environment — using anonymous access (public repos only).",
            file=sys.stderr,
            flush=True,
        )
    if args.kind == "image_adapter":
        from huggingface_hub import snapshot_download

        dest.mkdir(parents=True, exist_ok=True)
        snapshot_download(
            repo_id=repo_id,
            local_dir=str(dest),
            max_workers=4,
            token=hf_token_argument(),
            allow_patterns=["*.safetensors", "*.json", "*.txt", "*.bin"],
        )
    else:
        download_snapshot(repo_id, dest)
        if not snapshot_ready(dest, kind=args.kind):
            raise RuntimeError(
                f"Download of '{repo_id}' finished without deployable weight files under {dest}. "
                "Retry from Models → Download snapshot."
            )
        label = args.label.strip() or None
        register_installed_model(root, repo_id, args.kind, label=label)
    print(json.dumps({"dest": str(dest), "repoId": repo_id, "kind": args.kind, "verified": True}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
