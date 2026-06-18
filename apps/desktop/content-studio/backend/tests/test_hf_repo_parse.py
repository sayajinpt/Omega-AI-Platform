from localgen.hf_urls import parse_hf_repo_id


def test_parse_hf_repo_id_bare() -> None:
    assert parse_hf_repo_id(" Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice ") == "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"


def test_parse_hf_repo_id_url() -> None:
    assert (
        parse_hf_repo_id("https://huggingface.co/stabilityai/stable-diffusion-3.5-medium/tree/main")
        == "stabilityai/stable-diffusion-3.5-medium"
    )


def test_parse_hf_repo_id_invalid() -> None:
    assert parse_hf_repo_id("") is None
    assert parse_hf_repo_id("not-a-repo") is None
