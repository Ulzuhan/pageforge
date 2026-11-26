#!/usr/bin/env bash
# Runs a tool's image with the environment the suites prepared, hardened like
# production (read-only, no capabilities, no new privileges, uid 10001).
#   TEST_LAUNCH=1 TEST_IMAGE_PREFIX=pageforge-ci node scripts/test-http.mjs
set -euo pipefail
tool="$1"
prefix=$(echo "$tool" | tr '[:lower:]' '[:upper:]')
image="${TEST_IMAGE_PREFIX:-pageforge-ci}-${tool}"
exec docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env-file <(env | grep -E "^(${prefix}_|HOSTNAME=|PORT=)") "$image"
