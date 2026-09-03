import { Elysia, t } from "elysia";
import { clientIp, rateLimited } from "./ratelimit";
import {
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_MIMES,
  SEVERITIES,
  addFeedback,
  consumeToken,
  createToken,
  getScreenshot,
  getToken,
  isTokenExpired,
  listFeedback,
} from "./db";

const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error("ADMIN_KEY must be set");
  process.exit(1);
}

export const httpRoutes = () =>
  new Elysia()
    .get("/", () => ({ ok: true }))

    // Mint a single-use feedback token. Open endpoint — spam gate is rate limit.
    // Skills ship only the host URL, never a secret.
    .post("/token", ({ request, set }) => {
      if (rateLimited(clientIp(request.headers))) {
        set.status = 429;
        return { error: "rate limit exceeded", retry_after: 60 };
      }
      return { token: createToken() };
    })

    // Submit feedback. Requires a valid single-use token.
    .post(
      "/feedback",
      ({ body, headers, request, set }) => {
        if (rateLimited(clientIp(request.headers))) {
          set.status = 429;
          return { error: "rate limit exceeded", retry_after: 60 };
        }

        const token = headers["x-feedback-token"];
        if (!token) {
          set.status = 401;
          return { error: "missing token" };
        }

        const row = getToken(token);
        if (!row || row.used === 1 || isTokenExpired(row.created_at)) {
          set.status = 401;
          return { error: "invalid or expired token" };
        }

        const { source, message, rating, severity, agent_id, screenshot, screenshot_mime } = body;
        const ratingNum =
          typeof rating === "number" && rating >= 1 && rating <= 5 ? Math.trunc(rating) : null;
        const sev =
          typeof severity === "string" && SEVERITIES.has(severity) ? severity : "info";
        const agent = typeof agent_id === "string" && agent_id.trim() ? agent_id.trim() : null;

        // ponytail: Buffer.from ignores invalid base64 chars silently; size checks are the real gate.
        let shot: Buffer | null = null;
        if (typeof screenshot === "string" && screenshot.length) {
          if (screenshot.length > (MAX_SCREENSHOT_BYTES / 3) * 4) {
            set.status = 413;
            return { error: `screenshot too large (max ${MAX_SCREENSHOT_BYTES / 1024 / 1024}MB)` };
          }
          shot = Buffer.from(screenshot, "base64");
          if (shot.length === 0 || shot.length > MAX_SCREENSHOT_BYTES) {
            set.status = 422;
            return { error: "screenshot is empty or too large" };
          }
        }
        const shotMime =
          typeof screenshot_mime === "string" && SCREENSHOT_MIMES.has(screenshot_mime)
            ? screenshot_mime
            : "image/png";

        const id = addFeedback({
          source: source.trim(),
          message: message.trim(),
          severity: sev,
          rating: ratingNum,
          agent_id: agent,
          screenshot: shot,
          screenshot_mime: shot ? shotMime : null,
        });
        consumeToken(token);
        set.status = 201;
        return { id };
      },
      {
        body: t.Object({
          source: t.String(),
          message: t.String(),
          rating: t.Optional(t.Number()),
          severity: t.Optional(t.String()),
          agent_id: t.Optional(t.String()),
          screenshot: t.Optional(t.String()),
          screenshot_mime: t.Optional(t.String()),
        }),
      }
    )

    // Fetch a feedback entry's screenshot (private admin key).
    .get("/feedback/:id/screenshot", ({ params, headers, set }) => {
      if (headers["x-api-key"] !== ADMIN_KEY) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { error: "invalid id" };
      }
      const shot = getScreenshot(id);
      if (!shot) {
        set.status = 404;
        return { error: "no screenshot for this feedback id" };
      }
      return new Response(shot.bytes, {
        headers: { "content-type": shot.mime ?? "application/octet-stream" },
      });
    })

    // Read feedback (private admin key).
    .get("/feedback", ({ query, headers, set }) => {
      if (headers["x-api-key"] !== ADMIN_KEY) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return listFeedback({
        limit: parseInt(query.limit ?? "50") || undefined,
        offset: parseInt(query.offset ?? "0") || undefined,
        source: query.source,
      });
    });
