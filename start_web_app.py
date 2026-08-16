"""Start the current PulseWindow localhost app and open it in a browser."""

from __future__ import annotations

import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent / "web-app"
VITE = PROJECT_DIR / "node_modules" / ".bin" / "vite"


def available_port(start: int = 3000, attempts: int = 20) -> int:
    for port in range(start, start + attempts):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("No free local port was found.")


def wait_until_ready(url: str, process: subprocess.Popen[bytes]) -> bool:
    for _ in range(60):
        if process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                return response.status < 500
        except OSError:
            time.sleep(0.25)
    return False


def main() -> None:
    if not VITE.exists():
        print("The web app needs to be prepared first.")
        print(f"Open Terminal in {PROJECT_DIR} and run: npm install")
        raise SystemExit(1)

    port = available_port()
    url = f"http://localhost:{port}"
    print("\nStarting PulseWindow — medication schedule edition…", flush=True)
    print(f"Local link: {url}", flush=True)
    print("Keep this Terminal window open. Press Control-C to stop.\n", flush=True)
    process = subprocess.Popen(
        [str(VITE), "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=PROJECT_DIR,
    )
    try:
        if not wait_until_ready(url, process):
            raise RuntimeError("The local website did not finish starting.")
        webbrowser.open(url)
        process.wait()
    except KeyboardInterrupt:
        print("\nStopping PulseWindow…")
    except RuntimeError as error:
        print(f"\n{error}", file=sys.stderr)
        raise SystemExit(1) from error
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
