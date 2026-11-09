---
name: feedback-server
description: Send or read feedback via Collin's feedback server (aspectrr/feedback-server). Use at session end to submit user feedback, when asked to leave/send feedback, read or list feedback entries, attach screenshots to feedback, or work with the feedback MCP server or /token + /feedback endpoints.
---

# Feedback server

Send feedback to Collin, or read past feedback. Server base URL: `https://aspectrr-feedback.fly.dev` (swap in the deployed URL if it moves).

Auth model: connections are OAuth 2.1 (browser consent once, tokens auto-refresh). Each feedback **write** consumes a one-time code; reads never do. The `get_feedback_token` tool mints codes, so an agent never handles auth manually.

## Setup: connect the MCP server (once per machine)

```bash
pi mcp add feedback --url https://aspectrr-feedback.fly.dev/mcp
```

No tokens or headers. On first connect pi detects the OAuth challenge and opens a browser: click **Allow** once. Pi stores and refreshes tokens automatically. Completion check: `list_feedback` returns entries (or an empty list) without a 401.

## Steps

1. **Ask the user once** whether they want to leave feedback (typically at session end). If they decline, stop here.
2. **Submit** with the `submit_feedback` tool: `source` = this skill or app name, `message` = the user's own words, optional `rating` (1-5), `severity`, `agent_id`, and base64 `screenshot` (max 4MB). Done when the result returns `{ "id": … }`.
3. **On errors, follow the message**: `already used` → call `get_feedback_token`, then retry `submit_feedback` passing its token as the `code` argument. `expired` → same. A 401 at connect time means the OAuth grant is missing — run the setup step (interactive so the browser can open).
4. **Read** (when asked to review feedback): `list_feedback` (filter by `source`, paginate with `limit`/`offset`), and `get_feedback_screenshot` for entries with `has_screenshot: 1`.

## Fallback: plain curl (no MCP client)

```bash
TOKEN=$(curl -s -X POST https://aspectrr-feedback.fly.dev/token | jq -r .token)
curl -s -X POST https://aspectrr-feedback.fly.dev/feedback \
  -H "x-feedback-token: $TOKEN" -H "content-type: application/json" \
  -d '{"source":"<SKILL-NAME>","message":"<their words>","rating":<1-5 or omit>,"agent_id":"pi"}'
```

Read entries back over MCP (`list_feedback`), or with the admin key: `GET /feedback` (and `GET /feedback/<id>/screenshot` for raw images).
