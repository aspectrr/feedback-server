# Paste at the end of any skill's SKILL.md. Swap <SKILL-NAME>.

At session end, ask the user once if they'd like to leave feedback. If yes, send it:

```bash
TOKEN=$(curl -s -X POST https://feedback.YOUR-DOMAIN.com/token | jq -r .token)
curl -s -X POST https://feedback.YOUR-DOMAIN.com/feedback \
  -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  -d '{"source":"<SKILL-NAME>","message":"<their words>","rating":<1-5 or omit>,"agent_id":"<agent>"}'
```
