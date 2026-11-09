#!/bin/bash
# End-to-end check: boots server on a temp DB, exercises the screenshot flow.
set -e
cd "$(dirname "$0")"
TMP=$(mktemp -d)
DB_PATH="$TMP/fb.db" PORT=3199 ADMIN_KEY=testkey RATE_LIMIT=100 bun run src/index.ts &
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

# browser CORS preflight + actual request carry ACAO headers
ACAO=$(curl -s -D - -o /dev/null -X OPTIONS $BASE/token -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" | grep -i '^access-control-allow-origin' | tr -d '\r')
[ -n "$ACAO" ] || { echo "FAIL: CORS preflight"; exit 1; }
ACAO=$(curl -s -D - -o /dev/null -X POST $BASE/token -H "Origin: https://example.com" | grep -i '^access-control-allow-origin' | tr -d '\r')
[ -n "$ACAO" ] || { echo "FAIL: CORS POST"; exit 1; }

# severity "bug" accepted (online-poker sends it)
TOKEN=$(curl -s -X POST $BASE/token | jq -r .token)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/feedback \
  -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  -d '{"source":"test","message":"bug sev","severity":"bug"}')
[ "$CODE" = "201" ] || { echo "FAIL: severity bug, got $CODE"; exit 1; }

# oversize rejected with 413
TOKEN=$(curl -s -X POST $BASE/token | jq -r .token)
BIG=$(head -c 6000000 /dev/zero | base64 | tr -d '\n')
printf '{"source":"test","message":"big","screenshot":"%s"}' "$BIG" > "$TMP/big.json"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/feedback \
  -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  --data-binary @"$TMP/big.json")
[ "$CODE" = "413" ] || { echo "FAIL: size cap, got $CODE"; exit 1; }

# MCP: no auth → 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
[ "$CODE" = "401" ] || { echo "FAIL: mcp no-auth, got $CODE"; exit 1; }

# MCP: bogus code → 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/mcp -H "authorization: Bearer nope" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
[ "$CODE" = "401" ] || { echo "FAIL: mcp bogus code, got $CODE"; exit 1; }

# MCP: one-time code works (initialize → tools/call; handler answers SSE, peel data: line)
MTOKEN=$(curl -s -X POST $BASE/token | jq -r .token)
INIT=$(curl -s -X POST $BASE/mcp -H "authorization: Bearer $MTOKEN" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | sed -n 's/^data: //p')
echo "$INIT" | jq -e '.result.serverInfo.name == "feedback"' >/dev/null || { echo "FAIL: mcp initialize"; exit 1; }
CALL=$(curl -s -X POST $BASE/mcp -H "authorization: Bearer $MTOKEN" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_feedback","arguments":{"limit":5}}}' | sed -n 's/^data: //p')
echo "$CALL" | jq -e '.result.content[0].text | fromjson | length > 0' >/dev/null || { echo "FAIL: mcp tools/call"; exit 1; }

# MCP: a code already consumed by /feedback still reads until TTL (by design)
UTOKEN=$(curl -s -X POST $BASE/token | jq -r .token)
curl -s -o /dev/null -X POST $BASE/feedback -H "x-feedback-token: $UTOKEN" \
  -H "content-type: application/json" -d '{"source":"test","message":"consumed"}'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/mcp -H "authorization: Bearer $UTOKEN" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')
[ "$CODE" = "200" ] || { echo "FAIL: mcp after consume, got $CODE"; exit 1; }

# MCP: 401 body teaches the bootstrap
curl -s -X POST $BASE/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | jq -e '.hint | test("/token")' >/dev/null || { echo "FAIL: mcp 401 hint"; exit 1; }

# MCP: get_feedback_token → submit_feedback(code) → single-use teaching error
FRESH=$(curl -s -X POST $BASE/mcp -H "authorization: Bearer $MTOKEN" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"get_feedback_token","arguments":{}}}' \
  | sed -n 's/^data: //p' | jq -r '.result.content[0].text | fromjson | .token')
[ -n "$FRESH" ] && [ "$FRESH" != "null" ] || { echo "FAIL: mcp get_feedback_token"; exit 1; }

SUB=$(curl -s -X POST $BASE/mcp -H "authorization: Bearer $MTOKEN" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"submit_feedback\",\"arguments\":{\"source\":\"test\",\"message\":\"via mcp\",\"rating\":5,\"code\":\"$FRESH\"}}}" \
  | sed -n 's/^data: //p')
echo "$SUB" | jq -e '.result.content[0].text | fromjson | .id > 0' >/dev/null || { echo "FAIL: mcp submit_feedback"; exit 1; }

SUB2=$(curl -s -X POST $BASE/mcp -H "authorization: Bearer $MTOKEN" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"submit_feedback\",\"arguments\":{\"source\":\"test\",\"message\":\"again\",\"code\":\"$FRESH\"}}}" \
  | sed -n 's/^data: //p')
echo "$SUB2" | jq -e '.result.isError == true and (.result.content[0].text | test("get_feedback_token"))' >/dev/null \
  || { echo "FAIL: mcp single-use teaching error"; exit 1; }

# --- OAuth 2.1: full headless flow (what pi does, minus the browser) ---
MCPCURL=(-s -X POST $BASE/mcp -H "accept: application/json, text/event-stream" -H "content-type: application/json")

# 401 carries the discovery pointer
HDRS=$(curl -s -D - -o /dev/null -X POST $BASE/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
echo "$HDRS" | grep -qi 'www-authenticate: Bearer resource_metadata' || { echo "FAIL: oauth 401 challenge"; exit 1; }

# discovery endpoints
curl -s $BASE/.well-known/oauth-protected-resource/mcp | jq -e '.authorization_servers | length == 1' >/dev/null || { echo "FAIL: oauth resource metadata"; exit 1; }
curl -s $BASE/.well-known/oauth-authorization-server | jq -e '(.code_challenge_methods_supported == ["S256"]) and (.grant_types_supported | length == 2)' >/dev/null \
  || { echo "FAIL: oauth server metadata"; exit 1; }

# dynamic client registration
CID=$(curl -s -X POST $BASE/register -H "content-type: application/json" \
  -d '{"client_name":"smoke-cli","redirect_uris":["http://localhost:9999/cb"]}' | jq -r .client_id)
[ -n "$CID" ] && [ "$CID" != "null" ] || { echo "FAIL: oauth DCR"; exit 1; }

# authorize → consent → code (curl acts as the browser)
VER=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=_\n')
CHAL=$(printf %s "$VER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=_\n')
CONSENT=$(curl -s "$BASE/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&code_challenge=$CHAL&code_challenge_method=S256&state=s1")
APPROVE_ID=$(echo "$CONSENT" | grep -o 'approve?id=[a-f0-9-]*' | head -1 | cut -d= -f2)
[ -n "$APPROVE_ID" ] || { echo "FAIL: oauth consent page"; exit 1; }
REDIR=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/authorize/approve?id=$APPROVE_ID")
AUTH_CODE=$(echo "$REDIR" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
echo "$REDIR" | grep -q 'state=s1' || { echo "FAIL: oauth state roundtrip"; exit 1; }
[ -n "$AUTH_CODE" ] || { echo "FAIL: oauth code"; exit 1; }

# exchange with PKCE; code is single-use
TOK=$(curl -s -X POST $BASE/oauth/token \
  -d "grant_type=authorization_code&code=$AUTH_CODE&client_id=$CID&redirect_uri=http://localhost:9999/cb&code_verifier=$VER")
ACCESS=$(echo "$TOK" | jq -r .access_token)
REFRESH=$(echo "$TOK" | jq -r .refresh_token)
[ -n "$ACCESS" ] && [ "$ACCESS" != "null" ] && [ -n "$REFRESH" ] || { echo "FAIL: oauth token exchange: $TOK"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${MCPCURL[@]}" -H "authorization: Bearer $ACCESS" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$CODE" = "200" ] || { echo "FAIL: oauth bearer on /mcp, got $CODE"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/oauth/token \
  -d "grant_type=authorization_code&code=$AUTH_CODE&client_id=$CID&redirect_uri=http://localhost:9999/cb&code_verifier=$VER")
[ "$CODE" = "400" ] || { echo "FAIL: oauth code reuse, got $CODE"; exit 1; }

# wrong verifier rejected
curl -s "$BASE/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&code_challenge=$CHAL&code_challenge_method=S256" \
  | grep -o 'approve?id=[a-f0-9-]*' | head -1 | cut -d= -f2 > "$TMP/apid"
REDIR=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/authorize/approve?id=$(cat "$TMP/apid")")
AUTH_CODE2=$(echo "$REDIR" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/oauth/token \
  -d "grant_type=authorization_code&code=$AUTH_CODE2&client_id=$CID&redirect_uri=http://localhost:9999/cb&code_verifier=WRONG")
[ "$CODE" = "400" ] || { echo "FAIL: oauth bad PKCE, got $CODE"; exit 1; }

# refresh rotation: new pair works, old refresh revoked
TOK2=$(curl -s -X POST $BASE/oauth/token \
  -d "grant_type=refresh_token&refresh_token=$REFRESH&client_id=$CID")
ACCESS2=$(echo "$TOK2" | jq -r .access_token)
[ -n "$ACCESS2" ] && [ "$ACCESS2" != "null" ] || { echo "FAIL: oauth refresh: $TOK2"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${MCPCURL[@]}" -H "authorization: Bearer $ACCESS2" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$CODE" = "200" ] || { echo "FAIL: oauth refreshed bearer, got $CODE"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/oauth/token \
  -d "grant_type=refresh_token&refresh_token=$REFRESH&client_id=$CID")
[ "$CODE" = "400" ] || { echo "FAIL: oauth refresh replay, got $CODE"; exit 1; }

# garbage bearer rejected
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${MCPCURL[@]}" -H "authorization: Bearer garbage" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$CODE" = "401" ] || { echo "FAIL: oauth garbage bearer, got $CODE"; exit 1; }

echo "smoke OK"
