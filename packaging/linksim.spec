# PyInstaller spec for the LinkSim tester build (run via packaging/build.ps1).
# Output: dist/LinkSim/LinkSim.exe + dist/LinkSim/_internal/
import os

from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

hidden = (
    collect_submodules("uvicorn")      # uvicorn picks its loop/protocols at runtime
    # The app's code, without tests and admin scripts.
    + collect_submodules("backend", filter=lambda n: not n.startswith(
        ("backend.tests", "backend.scripts", "backend.test_")))
    + ["main"]
)

a = Analysis(
    [os.path.join(SPECPATH, "desktop_launcher.py")],
    pathex=[ROOT],
    datas=[(os.path.join(ROOT, "frontend", "dist"), "frontend_dist")],
    hiddenimports=hidden,
    # Not used by the app: keep tests and build/dev tools out of the exe.
    excludes=["pytest", "_pytest", "backend.tests", "tkinter", "IPython", "matplotlib", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="LinkSim",
    console=True,          # the black window: shows the address, closing it stops LinkSim
    upx=False,             # UPX-packed exes get flagged by antivirus more often
    version=os.path.join(SPECPATH, "version_info.txt"),
)
coll = COLLECT(exe, a.binaries, a.datas, name="LinkSim", upx=False)
