import { Elysia, t } from "elysia";
import { clientIp, rateLimited } from "./ratelimit";
import {
  SEVERITIES,
  addFeedback,
  consumeToken,
  createToken,
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

        const { source, message, rating, severity, agent_id } = body;
        const ratingNum =
          typeof rating === "number" && rating >= 1 && rating <= 5 ? Math.trunc(rating) : null;
        const sev =
          typeof severity === "string" && SEVERITIES.has(severity) ? severity : "info";
        const agent = typeof agent_id === "string" && agent_id.trim() ? agent_id.trim() : null;

        const id = addFeedback({
          source: source.trim(),
          message: message.trim(),
          severity: sev,
          rating: ratingNum,
          agent_id: agent,
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
        }),
      }
    )

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
