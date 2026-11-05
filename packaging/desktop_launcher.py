"""
LinkSim tester build — the program behind LinkSim.exe.

Starts the LinkSim server on this PC only (127.0.0.1), serves the web page
from the same server, and opens it in the default browser. Data (database +
log) is kept in %LOCALAPPDATA%\\LinkSim, so a newer LinkSim.exe keeps it.
Closing the console window stops LinkSim.
"""
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser

APP_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LinkSim")
PORT_FILE = os.path.join(DATA_DIR, "port.txt")


def _is_running(port: int) -> bool:
    """A LinkSim tester build on this port: /health answers and the page is
    served (a development server answers /health too, but serves no page)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
            if b"linksim" not in r.read():
                return False
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def _running_port():
    """The port of a LinkSim already started on this PC, if any."""
    try:
        port = int(open(PORT_FILE, encoding="utf-8").read().strip())
    except Exception:
        return None
    return port if _is_running(port) else None


def _free_port() -> int:
    for port in (8000, 0):  # 8000 if it's free, else any free port
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("No free port found")


def _open_when_ready(port: int, url: str) -> None:
    for _ in range(240):
        if _is_running(port):
            print(f"\n  LinkSim is running at  {url}")
            print("  Keep this window open while you use LinkSim. Close it to quit.\n")
            webbrowser.open(url)
            return
        time.sleep(0.5)
    print("\n  LinkSim is taking long to start. Try opening this address in your browser:", url)


def main() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)

    port = _running_port()
    if port is not None:
        print("LinkSim is already running — opening it in your browser.")
        webbrowser.open(f"http://127.0.0.1:{port}")
        time.sleep(3)
        return

    # Read by main.py, backend/storage/database.py and backend/api/auth.py.
    os.environ["LINKSIM_DATA_DIR"] = DATA_DIR
    os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(DATA_DIR, "linksim.db").replace("\\", "/")
    os.environ["LINKSIM_STATIC_DIR"] = os.path.join(APP_DIR, "frontend_dist")
    os.environ["LINKSIM_DESKTOP"] = "1"

    port = _free_port()
    url = f"http://127.0.0.1:{port}"
    with open(PORT_FILE, "w", encoding="utf-8") as f:
        f.write(str(port))

    print("Starting LinkSim, please wait...")
    import uvicorn
    from main import app

    threading.Thread(target=_open_when_ready, args=(port, url), daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except BaseException:  # SystemExit too: uvicorn exits that way if it can't start
        traceback.print_exc()
        print("\nLinkSim could not start. Please send this message and the file")
        print(os.path.join(DATA_DIR, "linksim.log"), "to the person who gave you LinkSim.")
        input("\nPress Enter to close this window...")
