"""
LinkSim tester build — the program behind LinkSim.exe.

Starts LinkSim's own private PostgreSQL (bundled in the pgsql folder), then
the LinkSim server, both on this PC only (127.0.0.1); serves the web page
from the same server and opens it in the default browser. Data (database +
log) is kept in %LOCALAPPDATA%\\LinkSim, so a newer LinkSim.exe keeps it.
Closing the console window stops LinkSim and its database.
"""
import atexit
import ctypes
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser

APP_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LinkSim")
PORT_FILE = os.path.join(DATA_DIR, "port.txt")

# The private PostgreSQL: program files in the build, data in DATA_DIR.
PG_BIN = os.path.join(APP_DIR, "pgsql", "bin")
PG_DATA = os.path.join(DATA_DIR, "pgdata")
PG_PASSWORD_FILE = os.path.join(DATA_DIR, "db_password.txt")
PG_LOG = os.path.join(DATA_DIR, "postgres.log")
PG_USER = "linksim"
PG_DB = "linksim"
# A database from an older LinkSim (SQLite): copied in once, then renamed.
OLD_SQLITE = os.path.join(DATA_DIR, "linksim.db")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _pg(tool: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run a PostgreSQL tool (initdb, pg_ctl) from the bundled pgsql folder,
    in its own hidden window (so the database isn't tied to the black window).
    Its output goes to a file, not a pipe: the server started by pg_ctl would
    keep a pipe open and the call would never return."""
    # One file per action: the running server keeps "pg_ctl start"'s open.
    out_path = os.path.join(DATA_DIR, f"pg_{tool}_{args[0] if args and not args[0].startswith('-') else 'run'}.log")
    with open(out_path, "w", encoding="utf-8", errors="replace") as out:
        r = subprocess.run([os.path.join(PG_BIN, tool + ".exe"), *args], stdin=subprocess.DEVNULL,
                           stdout=out, stderr=subprocess.STDOUT, creationflags=_NO_WINDOW)
    if check and r.returncode != 0:
        with open(out_path, encoding="utf-8", errors="replace") as f:
            msg = f.read()
        if tool == "pg_ctl" and os.path.isfile(PG_LOG):
            with open(PG_LOG, encoding="utf-8", errors="replace") as f:
                msg += "\n--- postgres.log (end) ---\n" + "".join(f.readlines()[-20:])
        raise RuntimeError(f"{tool} failed:\n{msg}")
    return r


def _free_db_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _init_database() -> None:
    """First start: create the private database, signed in with a random
    password kept only in DATA_DIR."""
    print("First start: setting up LinkSim's database (takes a few seconds)...")
    password = secrets.token_urlsafe(24)
    pwfile = os.path.join(DATA_DIR, "initdb_pw.tmp")
    with open(pwfile, "w", encoding="utf-8") as f:
        f.write(password)
    try:
        _pg("initdb", "-D", PG_DATA, "-U", PG_USER, "--pwfile", pwfile, "-A", "scram-sha-256",
            "-E", "UTF8", "--locale=C")
    except Exception:
        shutil.rmtree(PG_DATA, ignore_errors=True)  # so the next start tries again
        raise
    finally:
        os.remove(pwfile)
    with open(PG_PASSWORD_FILE, "w", encoding="utf-8") as f:
        f.write(password)


def _stop_database() -> None:
    if os.path.isfile(os.path.join(PG_DATA, "postmaster.pid")):
        _pg("pg_ctl", "stop", "-D", PG_DATA, "-m", "fast", "-w", "-t", "30", check=False)


def _on_console_close(_event) -> bool:
    # Closing the black window: stop the database too (Windows gives a few seconds).
    _stop_database()
    return False


_console_handler = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_uint)(_on_console_close) if os.name == "nt" else None


def _start_database() -> str:
    """Start the private PostgreSQL (setting it up on first start); returns its address."""
    if not os.path.isfile(os.path.join(PG_DATA, "PG_VERSION")):
        shutil.rmtree(PG_DATA, ignore_errors=True)
        _init_database()
    with open(PG_PASSWORD_FILE, encoding="utf-8") as f:
        password = f.read().strip()
    # Left running by a LinkSim that didn't close properly: stop it first.
    if _pg("pg_ctl", "status", "-D", PG_DATA, check=False).returncode == 0:
        _stop_database()
    port = _free_db_port()
    _pg("pg_ctl", "start", "-D", PG_DATA, "-l", PG_LOG, "-w", "-t", "60",
        "-o", f"-p {port} -c listen_addresses=127.0.0.1")
    atexit.register(_stop_database)
    if _console_handler is not None:
        ctypes.windll.kernel32.SetConsoleCtrlHandler(_console_handler, True)

    import psycopg
    conninfo = f"host=127.0.0.1 port={port} user={PG_USER} password={password}"
    with psycopg.connect(conninfo + " dbname=postgres", autocommit=True) as c:
        if c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (PG_DB,)).fetchone() is None:
            c.execute(f'CREATE DATABASE "{PG_DB}" ENCODING \'UTF8\' TEMPLATE template0')
    return f"postgresql+psycopg://{PG_USER}:{password}@127.0.0.1:{port}/{PG_DB}"


def _import_old_data(url: str) -> None:
    """Data from an older LinkSim (SQLite): copied into PostgreSQL once and
    checked row by row; the old file is then kept as linksim.db.imported."""
    if not os.path.isfile(OLD_SQLITE):
        return
    import psycopg
    with psycopg.connect(url.replace("postgresql+psycopg://", "postgresql://")) as c:
        has_users = c.execute("SELECT to_regclass('users') IS NOT NULL").fetchone()[0] and \
            c.execute("SELECT EXISTS (SELECT 1 FROM users)").fetchone()[0]
    if has_users:
        # Already moved (e.g. the rename below didn't happen last time).
        os.replace(OLD_SQLITE, OLD_SQLITE + ".imported")
        return
    print("Moving your data from the older LinkSim version (only once, please wait)...")
    from backend.scripts.migrate_sqlite_to_postgres import migrate
    log_path = os.path.join(DATA_DIR, "import_old_data.log")
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        migrate(OLD_SQLITE, url, log=lambda msg: log.write(msg + "\n"))
    os.replace(OLD_SQLITE, OLD_SQLITE + ".imported")
    print("Your data was moved.")


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

    print("Starting LinkSim, please wait...")
    db_url = _start_database()
    # Read by main.py, backend/storage/database.py and backend/api/auth.py.
    os.environ["LINKSIM_DATA_DIR"] = DATA_DIR
    os.environ["DATABASE_URL"] = db_url
    _import_old_data(db_url)
    os.environ["LINKSIM_STATIC_DIR"] = os.path.join(APP_DIR, "frontend_dist")
    os.environ["LINKSIM_DESKTOP"] = "1"
    # Read by backend/licensing.py (written into the build by build.ps1).
    with open(os.path.join(APP_DIR, "license_config.json"), encoding="utf-8-sig") as f:
        os.environ["LINKSIM_LICENSE_API_KEY"] = json.load(f)["api_key"]

    port = _free_port()
    url = f"http://127.0.0.1:{port}"
    with open(PORT_FILE, "w", encoding="utf-8") as f:
        f.write(str(port))

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
