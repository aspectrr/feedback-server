# @aspectrr/feedback-widget

Floating feedback button + modal for Solid sites. Rate 1-5, describe the issue,
optionally attach a screenshot of the current page (captured via
[modern-screenshot](https://github.com/qq15725/modern-screenshot), downscaled to
≤1600px, capped at the server's 4MB limit), submit to the aspectrr-feedback
server.

Built on [Kobalte](https://kobalte.dev/) primitives (accessible dialog: focus
trap, ESC, aria) in the shadcn idiom.

## Install

Public package on npm:

```bash
bun add @aspectrr/feedback-widget
```

## Use

```tsx
import { FeedbackWidget } from "@aspectrr/feedback-widget";

// in your root layout — `server` is required, nothing is hardcoded
<FeedbackWidget source="online-poker" server="https://aspectrr-feedback.fly.dev" />
```

Props:

| prop      | type     | default | notes                          |
| --------- | -------- | ------- | ------------------------------ |
| `source`  | `string` | required | site slug (`source` on server) |
| `server`  | `string` | required | feedback server base URL       |
| `agentId` | `string` | —        | forwarded as `agent_id`        |
| `label`   | `string` | `"Feedback"` | trigger button text        |

## Tailwind setup (required)

The widget uses hardcoded zinc-palette Tailwind classes (no shadcn theme vars
needed), so your host site's Tailwind must scan this package or the styles get
purged:

- Tailwind v4 — add to your CSS entry:

```css
@source "../node_modules/@aspectrr/feedback-widget";
```

- Tailwind v3 — add the package to `content` in `tailwind.config.js`:

```js
// Solid hosts compile from the shipped src/; non-Solid hosts use dist/.
content: [
  "./src/**/*.{ts,tsx}",
  "./node_modules/@aspectrr/feedback-widget/{src,dist}/**/*.{ts,tsx,js}",
],
```

## Server

Read feedback back via the admin API (`GET /feedback`,
`GET /feedback/:id/screenshot`) or the MCP server (`list_feedback`,
`get_feedback_screenshot`). CORS is enabled server-side for browser clients.

## Dev

```bash
bun install
bun run build   # vite lib build + d.ts into dist/
```

## Publish

Automatic — any push to `main` that touches `widget/**` builds and publishes
to public npm via OIDC trusted publishing (no NPM_TOKEN secret). The workflow
bumps the patch version past the registry's latest before publishing and
commits the bump back.
