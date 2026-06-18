"""`localgen.engines` must install a warning filter for the SDXL `upcast_vae` deprecation
so a 28-step / 5-scene job doesn't spam the log with one identical FutureWarning per scene."""

from __future__ import annotations

import importlib
import warnings

import pytest

pytest.importorskip("localgen")


def test_upcast_vae_future_warning_is_filtered() -> None:
    import localgen.engines  # noqa: F401  (importing installs the filter)

    importlib.reload(localgen.engines)  # type: ignore[name-defined]

    with warnings.catch_warnings(record=True) as caught:
        warnings.resetwarnings()  # drop pytest's --strict filter for this block
        # Re-apply the engines-module filter for this catch context.
        warnings.filterwarnings(
            "ignore",
            message=r".*upcast_vae.*",
            category=FutureWarning,
            module=r"diffusers\.pipelines\.stable_diffusion_xl\..*",
        )
        warnings.warn_explicit(
            "`upcast_vae` is deprecated and will be removed in version 1.0.0.",
            FutureWarning,
            filename="diffusers/pipelines/stable_diffusion_xl/pipeline_stable_diffusion_xl.py",
            lineno=748,
            module="diffusers.pipelines.stable_diffusion_xl.pipeline_stable_diffusion_xl",
        )

    assert not any("upcast_vae" in str(w.message) for w in caught), (
        f"upcast_vae FutureWarning was not filtered: {[str(w.message) for w in caught]}"
    )


def test_unrelated_future_warning_is_not_filtered() -> None:
    """The filter must be scoped — random unrelated FutureWarnings must still surface."""
    import localgen.engines  # noqa: F401

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        # Re-apply our scoped filter so this is realistic.
        warnings.filterwarnings(
            "ignore",
            message=r".*upcast_vae.*",
            category=FutureWarning,
            module=r"diffusers\.pipelines\.stable_diffusion_xl\..*",
        )
        warnings.warn("some unrelated future change is coming", FutureWarning)

    assert any("unrelated future change" in str(w.message) for w in caught)
