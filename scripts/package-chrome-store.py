"""Package only the built Chromium resources; never repository or environment files."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
import zipfile


def configuration(env):
    operation = env.get("RELEASE_OPERATION", "")
    if operation not in {"bootstrap", "package", "upload", "publish"}:
        raise ValueError("Select a Chrome Web Store operation")
    api = env.get("VITE_API_URL", "")
    panel = env.get("VITE_WEB_APP_URL", "")
    if api != "https://api.palladin.io":
        raise ValueError("This release requires the production API")
    if operation != "bootstrap":
        url = urlsplit(panel)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.hostname in {"localhost", "127.0.0.1", "::1"}
                or url.hostname.endswith((".localhost", ".invalid", ".example", ".test"))):
            raise ValueError("Configure CWS_WEB_APP_URL with the production HTTPS panel URL")
    return {"bootstrap": operation == "bootstrap", "apiUrl": api, "webAppUrl": panel,
            "sharedUnlockEnvironments": json.loads(env.get("VITE_SHARED_UNLOCK_ENVIRONMENTS") or "[]")}


def package(root, config, commit):
    source = root / "dist/chromium"
    manifest = json.loads((source / "manifest.json").read_text())
    version = manifest.get("version", "")
    parts = version.split(".")
    if (not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}", version)
            or any(int(v) > 65535 for v in parts) or not any(int(v) for v in parts)):
        raise ValueError("Chrome requires a valid nonzero manifest version")
    if version != json.loads((root / "package.json").read_text())["version"]:
        raise ValueError("Manifest and package versions differ")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("GITHUB_SHA must identify the built source commit")
    files = sorted(source.rglob("*"))
    if source.is_symlink():
        raise ValueError("Build directory must not be a symlink")
    for path in files:
        relative = path.relative_to(source)
        if (path.is_symlink() or any(part.startswith(".") for part in relative.parts)
                or path.suffix not in {"", ".js", ".json", ".html", ".css", ".png", ".svg", ".wasm"}):
            raise ValueError("Unexpected file in Chromium build; refusing to package")
    output = root / "dist/chrome-store"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "package.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in files:
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                bundle.writestr(info, path.read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    metadata = {**config, "version": version, "commit": commit, "sha256": digest,
                "publicKey": manifest["key"]}
    (output / "release.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (output / "package.zip.sha256").write_text(f"{digest}  package.zip\n")
    (output / "README.txt").write_text(
        "DRAFT ITEM REGISTRATION ONLY. Do not submit or publish. Panel is not configured.\n"
        if config["bootstrap"] else "Release candidate. Store upload, review and publication are separate states.\n")
    print("Created Chrome ZIP, checksum and release metadata" + (" (bootstrap only)" if config["bootstrap"] else ""))


if __name__ == "__main__":
    try:
        config = configuration(os.environ)
        if "--check-config" not in sys.argv:
            package(Path.cwd(), config, os.environ.get("GITHUB_SHA", ""))
    except (ValueError, KeyError, OSError):
        sys.exit("Chrome packaging failed: check release configuration, version and built files")
