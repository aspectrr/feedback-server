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

Read entries back via the MCP server (`list_feedback`; `get_feedback_screenshot` for attached images) or `GET /feedback` with the admin key — `GET /feedback/<id>/screenshot` returns the raw image.
