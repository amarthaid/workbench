#!/usr/bin/env bash
# Run the real PulseAudio + chromium audio test in a Linux container. macOS has
# no PulseAudio, so this is the only way to run it from a laptop. The repo is
# copied in (not npm-installed in place) so the host's native modules survive.
#
# Every stage is bounded by `timeout` inside the container: killing a docker
# client does not stop what it started there. --init reaps the chromium
# children orphaned when the test SIGKILLs chromium, so the leftover check at
# the end sees live processes only.
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm -t --init \
  -v "$PWD":/src:ro \
  -e TEST_AUDIO=1 -e NODE_ENV=test \
  node:26-bookworm-slim timeout 840 bash -c '
    set -e
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends python3 make g++ rsync procps pulseaudio pulseaudio-utils >/dev/null
    rsync -a --exclude node_modules --exclude .git --exclude "**/dist" /src/ /work/
    cd /work
    npm ci --no-audit --no-fund
    cd packages/server
    npx playwright install --with-deps chromium >/dev/null
    rc=0
    timeout 120 npx vitest run tests/audio-e2e.test.ts || rc=$?
    # Teardown must leave nothing running. Chromium children exit on their own
    # after the parent is killed, so give them a moment.
    # Live (non-zombie) audio/browser processes; comm is cut to 15 chars, hence
    # chrome_crashpad.
    leftovers() { ps -eo pid=,stat=,comm= | awk '"'"'$2 !~ /^Z/ && $3 ~ /^(pulseaudio|chrome|chrome_crashpad|parec|pacat)$/'"'"'; }
    for _ in $(seq 20); do
      [ -z "$(leftovers)" ] && break
      sleep 0.25
    done
    if [ -n "$(leftovers)" ]; then
      leftovers
      echo "audio-e2e: processes left running after the test (above)" >&2
      rc=1
    fi
    if ls -d /tmp/wb-pulse-* 2>/dev/null; then
      echo "audio-e2e: PulseAudio runtime dir left behind (above)" >&2
      rc=1
    fi
    exit $rc
  '
