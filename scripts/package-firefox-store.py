"""AMO resources and matching, allowlisted reviewer sources."""
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import zipfile

spec = importlib.util.spec_from_file_location("chrome_package", Path(__file__).with_name("package-chrome-store.py"))
chrome = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chrome)

SOURCE_DIRECTORIES = {"src", "manifest", "icons", "public", "scripts", "tests"}
SOURCE_FILES = {"package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
                "vitest.config.ts", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"}


def reviewer_sources(root, config):
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    selected = []
    for name in filter(None, names):
        path = Path(name)
        if path.parts[0] not in SOURCE_DIRECTORIES and name not in SOURCE_FILES:
            continue
        if (any(part.startswith(".") for part in path.parts)
                or any(parent.is_symlink() for parent in [root / path, *(root / path).parents])):
            raise ValueError("Unexpected hidden file or symlink in reviewer sources")
        selected.append(name)
    if not SOURCE_FILES.issubset(selected):
        raise ValueError("Missing reviewer build inputs")
    settings = {
        "VITE_API_URL": config["apiUrl"], "VITE_WEB_APP_URL": config["webAppUrl"],
        "VITE_SHARED_UNLOCK_ENVIRONMENTS": json.dumps(config["sharedUnlockEnvironments"], separators=(",", ":")),
        "VITE_POSTHOG_KEY": "",
    }
    rebuild = '''import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const settings = JSON.parse(readFileSync(new URL('./reviewer-config.json', import.meta.url)));
const env = { ...process.env, ...settings };
delete env.PALLADIN_STORE_CHANNEL;
for (const args of [['ci'], ['run', 'build:firefox']]) {
  const result = spawnSync('npm', args, { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
'''
    versions = {command: subprocess.check_output([command, "--version"]).decode().strip()
                for command in ["node", "npm"]}
    readme = f'''# AMO reviewer build

Install Node.js {versions['node']} and npm {versions['npm']} from https://nodejs.org/.
Build host: {platform.system()} {platform.release()}, {platform.machine()}.
The build uses public npm packages pinned in package-lock.json, without credentials.
Run from this extracted directory on Linux or macOS:

    node reviewer-build.mjs

Compare dist/firefox/ with the submitted package.zip. The generated resources
must match byte for byte. reviewer-config.json contains only public build settings.
Sources include the release-stamped manifest/package/lockfile and dependency notices.
This package does not enable Firefox Agent Inject or clipboard-copy controls.
'''
    output = root / "dist/firefox-store"
    archive = output / "sources.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        contents = {name: (root / name).read_bytes() for name in sorted(selected)}
        contents.update({"reviewer-config.json": (json.dumps(settings, indent=2) + "\n").encode(),
                         "reviewer-build.mjs": rebuild.encode(), "REVIEWER.md": readme.encode()})
        for name, data in sorted(contents.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, data)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "sources.zip.sha256").write_text(f"{digest}  sources.zip\n")


if __name__ == "__main__":
    try:
        root = Path.cwd()
        config = chrome.configuration(os.environ)
        if config["channel"] != "stable" or config["bootstrap"]:
            raise ValueError("Firefox packaging requires the configured stable release")
        version = chrome.validate_source(root, config, os.environ)
        chrome.package(root, config, os.environ.get("GITHUB_SHA", ""), version, "firefox")
        reviewer_sources(root, config)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError):
        sys.exit("Firefox packaging failed: check release configuration and reviewer build inputs")
