"""Package only the built Chromium resources; never repository or environment files."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit
import zipfile


def configuration(env):
    operation = env.get("RELEASE_OPERATION", "")
    if operation not in {"bootstrap", "package", "upload", "review", "publish"}:
        raise ValueError("Select a Chrome Web Store operation")
    channel = env.get("PALLADIN_STORE_CHANNEL", "stable")
    if channel not in {"stable", "beta"}:
        raise ValueError("Select stable or beta")
    if operation == "review" and channel != "stable":
        raise ValueError("Staged review requires the stable channel")
    api = env.get("VITE_API_URL", "")
    panel = env.get("VITE_WEB_APP_URL", "")
    if api not in {"https://api.palladin.io", "https://api.stage.palladin.io"}:
        raise ValueError("Configure CWS_API_URL with the staging or production API")
    if operation != "bootstrap":
        url = urlsplit(panel)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.hostname in {"localhost", "127.0.0.1", "::1"}
                or url.hostname.endswith((".localhost", ".invalid", ".example", ".test"))):
            raise ValueError("Configure CWS_WEB_APP_URL with the selected HTTPS panel URL")
    environments = json.loads(env.get("VITE_SHARED_UNLOCK_ENVIRONMENTS") or "[]")
    if operation != "bootstrap" and (not isinstance(environments, list)
            or {"apiUrl": api, "webOrigin": panel} not in environments):
        raise ValueError("Configure CWS_SHARED_UNLOCK_ENVIRONMENTS for the selected API and panel")
    return {"bootstrap": operation == "bootstrap", "channel": channel, "apiUrl": api, "webAppUrl": panel,
            "sharedUnlockEnvironments": environments}


def validate_source(root, config, env):
    ref = env.get("GITHUB_REF", "")
    operation = env.get("RELEASE_OPERATION")
    version = json.loads((root / "package.json").read_text())["version"]
    manifest = json.loads((root / "manifest/manifest.base.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    if any(value != version for value in [manifest["version"], lock["version"], lock["packages"][""]["version"]]):
        raise ValueError("Manifest, package and lockfile versions must match")
    if config["channel"] == "beta":
        if ref != "refs/heads/main":
            raise ValueError("Beta releases require main")
        number = int(env.get("GITHUB_RUN_NUMBER", "0"))
        if not 1 <= number <= 4294967295:
            raise ValueError("Beta requires a positive 32-bit CI run number")
        return f"0.0.{number // 65536}.{number % 65536}"
    if ref.startswith("refs/tags/") or operation in {"upload", "review", "publish"}:
        if not re.fullmatch(r"refs/tags/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", ref) or ref != f"refs/tags/v{version}":
            raise ValueError("Stable releases require a vX.Y.Z tag matching the source version")
        commit = env.get("GITHUB_SHA", "")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Missing source commit")
        subprocess.run(["git", "merge-base", "--is-ancestor", commit, "origin/main"],
                       cwd=root, check=True, capture_output=True)
    elif ref != "refs/heads/main":
        raise ValueError("Bootstrap and package operations require main or a release tag")
    return version


def package(root, config, commit, expected_version):
    source = root / "dist/chromium"
    manifest = json.loads((source / "manifest.json").read_text())
    version = manifest.get("version", "")
    parts = version.split(".")
    if (not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}", version)
            or any(int(v) > 65535 for v in parts) or not any(int(v) for v in parts)):
        raise ValueError("Chrome requires a valid nonzero manifest version")
    if version != expected_version:
        raise ValueError("Manifest version differs from the selected release")
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
    # CWS assigns/signs the store identity; key is only for unpacked development.
    store_manifest = {name: value for name, value in manifest.items() if name != "key"}
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in files:
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                data = ((json.dumps(store_manifest, indent=2) + "\n").encode()
                        if info.filename == "manifest.json" else path.read_bytes())
                bundle.writestr(info, data)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    metadata = {**config, "version": version, "commit": commit, "sha256": digest,
                "publicKey": manifest.get("key", "")}
    (output / "release.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (output / "package.zip.sha256").write_text(f"{digest}  package.zip\n")
    (output / "README.txt").write_text(
        "DRAFT ITEM REGISTRATION ONLY. Do not submit or publish. Release gates are incomplete.\n"
        if config["bootstrap"] else "Release candidate. Store upload, review and publication are separate states.\n")
    print("Created Chrome ZIP, checksum and release metadata" + (" (bootstrap only)" if config["bootstrap"] else ""))


if __name__ == "__main__":
    try:
        config = configuration(os.environ)
        expected_version = validate_source(Path.cwd(), config, os.environ)
        if "--check-config" not in sys.argv:
            package(Path.cwd(), config, os.environ.get("GITHUB_SHA", ""), expected_version)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError):
        sys.exit("Chrome packaging failed: check release configuration, version and built files")
