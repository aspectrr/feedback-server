import { Elysia, t } from "elysia";
import {
  OAUTH_CODE_TTL_MS,
  consumeAuthCode,
  createAuthCode,
  createOAuthClient,
  getAuthCode,
  getOAuthClient,
  issueTokens,
  rotateRefreshToken,
} from "./db";

// OAuth 2.1 authorization server so MCP clients (pi, Claude, …) connect the
// standard way: 401 → discovery → dynamic client registration → browser
// consent (PKCE S256) → bearer token, auto-refreshed by the client.
// The human approves once; that consent is what makes the credential real.
// Feedback one-time codes stay untouched — they gate writes, not connections.

const SCOPE = "feedback";
// Behind Fly's proxy TLS terminates at the edge: request.url is http:// even
// though the public origin is https://. Trust the forwarded proto/host so the
// issuer pi validates matches the public URL (RFC 8414).
export const origin = (request: Request) => {
  const fwdProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const fwdHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))?.split(",")[0].trim();
  if ((fwdProto === "http" || fwdProto === "https") && fwdHost && /^[\w.-]+(:\d+)?$/.test(fwdHost))
    return `${fwdProto}://${fwdHost}`;
  return new URL(request.url).origin;
};

// Pending consent requests live only in memory: a machine restart just means
// the user clicks again. Keyed by an unguessable id that only the consent
// page (opened by the human) ever sees.
const pending = new Map<
  string,
  { client_id: string; redirect_uri: string; code_challenge: string; state: string; scope: string }
>();

const metadata = (request: Request) => {
  const o = origin(request);
  return {
    issuer: o,
    registration_endpoint: `${o}/register`,
    authorization_endpoint: `${o}/authorize`,
    token_endpoint: `${o}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
};

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}
main{max-width:26rem;padding:2rem;background:#1c1c1e;border-radius:12px}h1{font-size:1.1rem}code{background:#2c2c2e;padding:.1rem .3rem;border-radius:4px}
a.btn{display:inline-block;margin:.5rem .5rem 0 0;padding:.5rem 1.2rem;border-radius:8px;text-decoration:none;color:#fff}
.allow{background:#0a84ff}.deny{background:#3a3a3c}</style></head>
<body><main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

export const oauthRoutes = () =>
  new Elysia()
    // RFC 9728 protected-resource metadata. Root + path-aware variant.
    .get("/.well-known/oauth-protected-resource", ({ request }) => {
      const o = origin(request);
      return { resource: `${o}/mcp`, authorization_servers: [o], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] };
    })
    .get("/.well-known/oauth-protected-resource/mcp", ({ request }) => {
      const o = origin(request);
      return { resource: `${o}/mcp`, authorization_servers: [o], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] };
    })

    // RFC 8414 authorization-server metadata.
    .get("/.well-known/oauth-authorization-server", ({ request }) => metadata(request))

    // Dynamic client registration (RFC 7591). Public PKCE clients only.
    .post(
      "/register",
      ({ body, request, set }) => {
        const uris = (body.redirect_uris ?? []).filter((u) => /^https?:\/\//.test(u));
        if (uris.length === 0) {
          set.status = 400;
          return { error: "invalid_client_metadata", error_description: "redirect_uris required" };
        }
        const client_id = createOAuthClient(body.client_name ?? "MCP client", uris);
        set.status = 201;
        const o = origin(request);
        return {
          client_id,
          client_name: body.client_name ?? "MCP client",
          redirect_uris: uris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint: `${o}/oauth/token`,
        };
      },
      {
        body: t.Object({
          client_name: t.Optional(t.String()),
          redirect_uris: t.Optional(t.Array(t.String())),
        }),
      }
    )

    // Authorization endpoint: validate, show consent page.
    .get(
      "/authorize",
      ({ query, request }) => {
        const o = origin(request);
        const client = query.client_id ? getOAuthClient(query.client_id) : null;
        if (!client) return page("Feedback server", "<h1>Unknown client</h1><p><code>client_id</code> not registered.</p>");
        if (!query.redirect_uri || !client.redirect_uris.includes(query.redirect_uri))
          return page("Feedback server", "<h1>Invalid redirect</h1><p><code>redirect_uri</code> not registered for this client.</p>");
        if (query.response_type !== "code")
          return page("Feedback server", "<h1>Unsupported</h1><p>Only <code>response_type=code</code> is supported.</p>");
        if (query.code_challenge_method !== "S256" || !query.code_challenge)
          return page("Feedback server", "<h1>PKCE required</h1><p><code>code_challenge_method=S256</code> is required.</p>");

        const id = crypto.randomUUID();
        pending.set(id, {
          client_id: query.client_id,
          redirect_uri: query.redirect_uri,
          code_challenge: query.code_challenge,
          state: query.state ?? "",
          scope: SCOPE,
        });
        // Trim old pending requests (walk-in clean).
        if (pending.size > 100) {
          const first = pending.keys().next().value;
          if (first) pending.delete(first);
        }
        return page(
          "Allow access? · Feedback server",
          `<h1>Allow access?</h1><p><strong>${client.client_name}</strong> wants to connect to your feedback server — read feedback and leave feedback on your behalf.</p>
<p>This is your own server; approving is what creates the client's access token.</p>
<p><a class="btn allow" href="${o}/authorize/approve?id=${id}">Allow</a><a class="btn deny" href="${o}/authorize/deny?id=${id}">Deny</a></p>`
        );
      },
      {
        query: t.Object({
          response_type: t.Optional(t.String()),
          client_id: t.Optional(t.String()),
          redirect_uri: t.Optional(t.String()),
          code_challenge: t.Optional(t.String()),
          code_challenge_method: t.Optional(t.String()),
          state: t.Optional(t.String()),
          scope: t.Optional(t.String()),
        }),
      }
    )

    .get("/authorize/approve", ({ query, set }) => {
      const id = query.id ?? "";
      const req = pending.get(id);
      if (!req) {
        set.status = 400;
        return page("Feedback server", "<h1>Expired</h1><p>This approval request is no longer valid — start the connection again.</p>");
      }
      pending.delete(id);
      const code = createAuthCode(req.client_id, req.redirect_uri, req.code_challenge, req.scope);
      const sep = req.redirect_uri.includes("?") ? "&" : "?";
      set.headers.location =
        `${req.redirect_uri}${sep}code=${code}${req.state ? `&state=${encodeURIComponent(req.state)}` : ""}`;
      set.status = 302;
    })

    .get("/authorize/deny", ({ query, set }) => {
      const id = query.id ?? "";
      const req = pending.get(id);
      if (req) {
        pending.delete(id);
        const sep = req.redirect_uri.includes("?") ? "&" : "?";
        set.headers.location =
          `${req.redirect_uri}${sep}error=access_denied${req.state ? `&state=${encodeURIComponent(req.state)}` : ""}`;
        set.status = 302;
        return;
      }
      set.status = 400;
      return page("Feedback server", "<h1>Expired</h1><p>This request is no longer valid.</p>");
    })

    // Token endpoint. PKCE S256: code_verifier must hash to the challenge.
    .post(
      "/oauth/token",
      async ({ body, set }) => {
        if (body.grant_type === "refresh_token") {
          if (!body.refresh_token || !body.client_id) {
            set.status = 400;
            return { error: "invalid_request" };
          }
          const fresh = await rotateRefreshToken(body.refresh_token, body.client_id);
          if (!fresh) {
            set.status = 400;
            return { error: "invalid_grant", error_description: "refresh token unknown, revoked, or expired" };
          }
          return fresh;
        }

        if (body.grant_type !== "authorization_code") {
          set.status = 400;
          return { error: "unsupported_grant_type" };
        }

        const fail = (description: string) => {
          set.status = 400;
          return { error: "invalid_grant", error_description: description };
        };
        const row = body.code ? getAuthCode(body.code) : null;
        if (!row) return fail("unknown code");
        if (row.used === 1) return fail("code already used");
        if (Date.now() - new Date(row.created_at.replace(" ", "T") + "Z").getTime() > OAUTH_CODE_TTL_MS)
          return fail("code expired");
        if (!body.client_id || body.client_id !== row.client_id) return fail("client mismatch");
        if (!body.redirect_uri || body.redirect_uri !== row.redirect_uri) return fail("redirect_uri mismatch");
        if (!body.code_verifier) return fail("code_verifier required");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
        if (Buffer.from(digest).toString("base64url") !== row.code_challenge) return fail("PKCE verification failed");

        consumeAuthCode(body.code);
        return issueTokens(row.client_id, row.scope);
      },
      {
        body: t.Object({
          grant_type: t.String(),
          code: t.Optional(t.String()),
          client_id: t.Optional(t.String()),
          redirect_uri: t.Optional(t.String()),
          code_verifier: t.Optional(t.String()),
          refresh_token: t.Optional(t.String()),
        }),
      }
    );
