"""Print JSON accelerator status for omega-runtime (``python -m localgen.media_accel_probe``)."""

from __future__ import annotations

import json

from localgen.torch_device import media_accelerators_report

if __name__ == "__main__":
    print(json.dumps(media_accelerators_report()), flush=True)
