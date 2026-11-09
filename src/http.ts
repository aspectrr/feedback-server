import { Elysia, t } from "elysia";
import { clientIp, rateLimited } from "./ratelimit";
import {
  addFeedback,
  consumeToken,
  createToken,
  getScreenshot,
  getToken,
  isTokenExpired,
  listFeedback,
  normalizeEntry,
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

        const n = normalizeEntry(body);
        if ("error" in n) {
          set.status = n.status;
          return { error: n.error };
        }

        const id = addFeedback(n.entry);
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
