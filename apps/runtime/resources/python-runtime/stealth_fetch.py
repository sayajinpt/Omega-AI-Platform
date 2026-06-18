#!/usr/bin/env python3
"""Headless page fetch via Playwright (replaces stealth-fetch.cjs)."""
import json
import sys


def main() -> None:
    try:
        args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except Exception as e:
        print(json.dumps({"ok": False, "output": f"invalid args json: {e}"}))
        return

    url = str(args.get("url", "")).strip()
    if not url:
        print(json.dumps({"ok": False, "output": "url required"}))
        return

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            json.dumps(
                {
                    "ok": False,
                    "output": "playwright not installed — run POST /v1/python/setup with profile full",
                }
            )
        )
        return

    timeout_ms = int(args.get("timeoutMs") or args.get("timeout_ms") or 45000)
    wait_ms = min(int(args.get("waitMs") or args.get("wait_ms") or 1500), 15000)
    selector = str(args.get("selector") or "").strip()
    user_agent = args.get("userAgent") or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    )

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled"],
            )
            context = browser.new_context(user_agent=user_agent, locale="en-US")
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            if wait_ms > 0:
                page.wait_for_timeout(wait_ms)
            text = ""
            if selector:
                try:
                    text = page.locator(selector).first.inner_text(timeout=8000)
                except Exception:
                    text = ""
            if not str(text).strip():
                text = page.evaluate("() => (document.body && document.body.innerText) || ''")
            title = page.title()
            out = json.dumps(
                {"url": page.url, "title": title, "text": str(text or "")[:120000]},
                indent=2,
            )
            browser.close()
        print(json.dumps({"ok": True, "output": out}))
    except Exception as e:
        print(json.dumps({"ok": False, "output": str(e)[:8000]}))


if __name__ == "__main__":
    main()
