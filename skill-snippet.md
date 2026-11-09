# Paste at the end of any skill's SKILL.md. Swap <SKILL-NAME>.

At session end, ask the user once if they'd like to leave feedback. If yes, send it:

```bash
TOKEN=$(curl -s -X POST https://feedback.YOUR-DOMAIN.com/token | jq -r .token)
curl -s -X POST https://feedback.YOUR-DOMAIN.com/feedback \
  -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  -d '{"source":"<SKILL-NAME>","message":"<their words>","rating":<1-5 or omit>,"agent_id":"<agent>"}'
```

Optional — attach a screenshot (base64, max 4MB):

```bash
SHOT=$(base64 -i screenshot.png | tr -d '\n')
TOKEN=$(curl -s -X POST https://feedback.YOUR-DOMAIN.com/token | jq -r .token)
curl -s -X POST https://feedback.YOUR-DOMAIN.com/feedback \
  -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  -d "{\"source\":\"<SKILL-NAME>\",\"message\":\"<their words>\",\"screenshot\":\"$SHOT\"}"
```

To read entries back, connect to the MCP server at `https://feedback.YOUR-DOMAIN.com/mcp` (streamable HTTP). The agent fetches a one-time code the same way, then sends it on every MCP request as `Authorization: Bearer $TOKEN` — use `list_feedback`, and `get_feedback_screenshot` for attached images. Codes live 10 minutes; grab a fresh one per session. (Admin key on `GET /feedback` still works for humans.)

If the agent is already connected to the MCP server, it can do the whole flow in-MCP: `get_feedback_token` mints a code, `submit_feedback` leaves feedback (pass the minted token as its `code` arg).
