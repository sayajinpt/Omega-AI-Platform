"""Embed a UTF-8 text file as a C string literal (one-time build helper)."""
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: embed_c_string.py <input> <output.h>")

    data = Path(sys.argv[1]).read_text(encoding="utf-8")
    out = Path(sys.argv[2])
    parts = []
    for line in data.splitlines(keepends=True):
        parts.append(
            line.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        )
    body = '"\n"'.join(parts)
    out.write_text(
        "#pragma once\n\n"
        f'static const char OMEGA_QWEN35_CHAT_TEMPLATE[] =\n    "{body}";\n',
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
