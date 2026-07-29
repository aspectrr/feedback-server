import { Elysia, t } from "elysia";
import { httpRoutes } from "./http";
import { mcpHandler } from "./mcp";

const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error("ADMIN_KEY must be set");
  process.exit(1);
}

const app = new Elysia()
  .use(httpRoutes())
  // MCP endpoint — agent connects here to read feedback. Same admin key as GET /feedback.
  .all("/mcp", ({ request, set }) => {
    if (request.headers.get("x-api-key") !== ADMIN_KEY) {
      set.status = 401;
      return { error: "unauthorized" };
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
