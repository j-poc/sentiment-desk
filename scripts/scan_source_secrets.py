"""Scan tracked/untracked application source and the built client, excluding local evidence and data stores."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOTS = (
    Path(".env.example"),
    Path("config"),
    Path("package.json"),
    Path("package-lock.json"),
    Path("engineering-contract.json"),
    Path("project-record"),
    Path("scripts"),
    Path("server"),
    Path("shared"),
    Path("tests"),
    Path("web/src"),
)
BUILT_CLIENT = Path("dist/web")


def paths_to_scan() -> set[Path]:
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout.decode("utf-8", "surrogateescape")
    candidates = {Path(item) for item in listed.split("\0") if item}
    return {
        relative
        for relative in candidates
        if any(relative == root or root in relative.parents for root in SOURCE_ROOTS)
        and (ROOT / relative).is_file()
        and not (ROOT / relative).is_symlink()
    }


def copy_file(relative: Path, destination: Path) -> None:
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / relative, target)


def main() -> int:
    gitleaks = shutil.which("gitleaks") or "/opt/homebrew/bin/gitleaks"
    if not Path(gitleaks).is_file():
        raise SystemExit("gitleaks is required for the source credential scan")
    source_paths = paths_to_scan()
    if not source_paths:
        raise SystemExit("no application source or configuration files were selected for scanning")
    if not (ROOT / BUILT_CLIENT).is_dir():
        raise SystemExit("built client assets are missing; run the production build first")

    with tempfile.TemporaryDirectory(prefix="sentiment-desk-secret-scan-") as temporary:
        scan_root = Path(temporary)
        for relative in source_paths:
            copy_file(relative, scan_root)
        for item in (ROOT / BUILT_CLIENT).rglob("*"):
            if item.is_file() and not item.is_symlink():
                copy_file(item.relative_to(ROOT), scan_root)
        result = subprocess.run(
            [gitleaks, "dir", "--no-banner", "--redact=100", "--max-target-megabytes", "20", "."],
            cwd=scan_root,
            check=False,
        )
    if result.returncode != 0:
        return result.returncode
    print(f"Credential scan passed for {len(source_paths)} source/config files and built client assets.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
