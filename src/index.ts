import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { httpRoutes } from "./http";
import { mcpHandler } from "./mcp";
import { oauthRoutes } from "./oauth";
import { getAccessToken, getToken, isTokenExpired } from "./db";

const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error("ADMIN_KEY must be set");
  process.exit(1);
}

const app = new Elysia()
  // Browser clients (feedback widget on hosted sites) call /token + /feedback
  // cross-origin. Admin routes stay key-gated; CORS doesn't change that.
  .use(cors())
  .use(httpRoutes())
  .use(oauthRoutes())
  // MCP endpoint. Connection auth, in order of preference:
  //   1. OAuth bearer token (pi/Claude do discovery + consent + auto-refresh)
  //   2. Admin key
  //   3. One-time feedback code from POST /token — valid until its 10-min TTL,
  //      because an MCP session needs several requests. Writes stay gated by
  //      single-use codes inside the tools.
  // No /mcp rate limit: MCP's opening burst would trip 10/min; unguessable
  // credentials are the gate.
  .all("/mcp", async ({ request, set }) => {
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)/i)?.[1];
    const codeRow = bearer ? getToken(bearer) : null;
    const authed =
      request.headers.get("x-api-key") === ADMIN_KEY ||
      (codeRow !== null && !isTokenExpired(codeRow.created_at)) ||
      (bearer !== null && (await getAccessToken(bearer)));
    if (!authed) {
      set.status = 401;
      const o = new URL(request.url).origin;
      set.headers["www-authenticate"] = `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource/mcp"`;
      return {
        error: "unauthorized",
        hint:
          `OAuth: connect with any MCP client and approve in the browser (one time). ` +
          `Manual fallback: curl -X POST ${o}/token → {"token":"…"}, then send "Authorization: Bearer <code>". ` +
          "Codes last 10 minutes and are single-use for writes; reads never consume one.",
      };
    }
    return mcpHandler.fetch(request);
  })
  .onError(({ code, set }) => {
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: "invalid request body" };
    }
  })
  .listen(Number(process.env.PORT ?? 3000));

console.log(`feedback server listening on ${app.server?.url}`);
