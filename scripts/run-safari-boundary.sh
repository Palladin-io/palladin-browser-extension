#!/usr/bin/env bash
set -euo pipefail

variant="${1:?Expected a Safari boundary variant}"
case "$variant" in
  classic-worker|module-worker|document|product) ;;
  *) echo 'Unknown Safari boundary variant' >&2; exit 2 ;;
esac

# This changes Safari automation settings only on a disposable hosted CI machine.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'Safari boundary runner requires a disposable GitHub-hosted machine' >&2
  exit 2
fi

output="test-results/shared-unlock-safari/$variant"
mkdir -p "$output"
python3 - <<'PY_CLEANUP'
import json
from pathlib import Path
for report in Path('test-results/shared-unlock-safari').glob('*/cleanup.json'):
    if not all(json.loads(report.read_text()).values()):
        raise SystemExit('Previous Safari variant did not clean up; refusing a contaminated session')
PY_CLEANUP
# A timeout can bypass Python's finally; later variants must then fail closed.
printf '%s\n' '{"extensionUninstalled":false,"sessionDeleted":false}' > "$output/cleanup.json"
driver_pid=''
cleanup() {
  if [[ -n "$driver_pid" ]]; then
    kill "$driver_pid" 2>/dev/null || true
    wait "$driver_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sudo /usr/bin/safaridriver --enable
/usr/bin/safaridriver -p 55187 > "$output/driver.log" 2>&1 &
driver_pid=$!
python3 - <<'PY'
import socket
import time
for attempt in range(50):
    try:
        with socket.create_connection(('127.0.0.1', 55187), timeout=1):
            break
    except OSError:
        time.sleep(0.2)
else:
    raise SystemExit('SafariDriver did not start')
PY

args=(--ci-screenshot-on-failure --ci-grant-fixture-access --output-dir "$output")
if [[ "$variant" == product ]]; then
  args+=(--product-extension dist/safari)
else
  args+=(--background-kind "$variant")
fi
python3 tests/browser/shared-unlock-safari-boundary.py "${args[@]}"
