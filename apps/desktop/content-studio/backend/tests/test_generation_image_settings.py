"""Image steps / size overrides from Omega Settings JSON."""

from __future__ import annotations

from app.services.generation_image_settings import image_size_for_repo, image_steps_for_repo


def test_image_size_for_repo_explicit() -> None:
    raw = '{"cutycat2000x/InterDiffusion-4.0": {"width": 768, "height": 768}}'
    assert image_size_for_repo("cutycat2000x/InterDiffusion-4.0", size_by_repo_json=raw) == (768, 768)


def test_image_size_for_repo_video_aspect() -> None:
    raw = '{"cutycat2000x/InterDiffusion-4.0": {"width": -1, "height": -1}}'
    assert image_size_for_repo("cutycat2000x/InterDiffusion-4.0", size_by_repo_json=raw) == (-1, -1)


def test_image_size_for_repo_zero_means_default() -> None:
    raw = '{"cutycat2000x/InterDiffusion-4.0": {"width": 0, "height": 0}}'
    assert image_size_for_repo("cutycat2000x/InterDiffusion-4.0", size_by_repo_json=raw) is None


def test_image_steps_for_repo_still_works() -> None:
    raw = '{"cutycat2000x/InterDiffusion-4.0": 12}'
    assert image_steps_for_repo("cutycat2000x/InterDiffusion-4.0", global_override=0, steps_by_repo_json=raw) == 12
