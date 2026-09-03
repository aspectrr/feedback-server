#!/bin/bash
# End-to-end check: boots server on a temp DB, exercises the screenshot flow.
set -e
cd "$(dirname "$0")"
TMP=$(mktemp -d)
DB_PATH="$TMP/fb.db" PORT=3199 ADMIN_KEY=testkey bun run src/index.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 1
BASE=http://localhost:3199

# plain feedback (no screenshot)
TOKEN=$(curl -s -X POST $BASE/token | jq -r .token)
ID=$(curl -s -X POST $BASE/feedback -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  -d '{"source":"test","message":"plain"}' | jq -r .id)
[ "$ID" -gt 0 ] || { echo "FAIL: plain feedback"; exit 1; }

# feedback with screenshot
printf '\x89PNG-fake-bytes' > "$TMP/shot.png"
SHOT=$(base64 -i "$TMP/shot.png" | tr -d '\n')
TOKEN=$(curl -s -X POST $BASE/token | jq -r .token)
SID=$(curl -s -X POST $BASE/feedback -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  -d "{\"source\":\"test\",\"message\":\"with shot\",\"screenshot\":\"$SHOT\"}" | jq -r .id)
[ "$SID" -gt 0 ] || { echo "FAIL: screenshot feedback"; exit 1; }

# list exposes has_screenshot without leaking blobs
curl -s $BASE/feedback -H "x-api-key: testkey" | jq -e \
  'map(select(.id == '"$SID"'))[0].has_screenshot == 1 and
   map(select(.id == '"$ID"'))[0].has_screenshot == 0 and
   (.[0] | keys | map(select(. == "screenshot")) | length == 0)' >/dev/null \
  || { echo "FAIL: list flags/blob leak"; exit 1; }

# screenshot roundtrip (bytes identical)
curl -s $BASE/feedback/$SID/screenshot -H "x-api-key: testkey" -o "$TMP/out.png"
cmp -s "$TMP/shot.png" "$TMP/out.png" || { echo "FAIL: screenshot roundtrip"; exit 1; }

# admin key required; no-screenshot id 404s
CODE=$(curl -s -o /dev/null -w '%{http_code}' $BASE/feedback/$ID/screenshot -H "x-api-key: wrong")
[ "$CODE" = "401" ] || { echo "FAIL: auth, got $CODE"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' $BASE/feedback/$ID/screenshot -H "x-api-key: testkey")
[ "$CODE" = "404" ] || { echo "FAIL: 404 path, got $CODE"; exit 1; }

# oversize rejected with 413
TOKEN=$(curl -s -X POST $BASE/token | jq -r .token)
BIG=$(head -c 6000000 /dev/zero | base64 | tr -d '\n')
printf '{"source":"test","message":"big","screenshot":"%s"}' "$BIG" > "$TMP/big.json"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/feedback \
  -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  --data-binary @"$TMP/big.json")
[ "$CODE" = "413" ] || { echo "FAIL: size cap, got $CODE"; exit 1; }

echo "smoke OK"
