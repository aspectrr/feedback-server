import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
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

// MCP server: agents read AND write feedback. Mounted at /mcp; auth is a
// one-time code from POST /token sent as `Authorization: Bearer <code>`
// (admin key accepted too). The factory runs per request, so each tool call
// closes over the code that arrived on its own request.
export const mcpHandler = createMcpHandler((ctx) => {
  const bearer =
    ctx.requestInfo?.headers.get("authorization")?.match(/^Bearer\s+(.+)/i)?.[1] ?? null;
  const origin = ctx.requestInfo ? new URL(ctx.requestInfo.url).origin : "";

  const server = new McpServer({ name: "feedback", version: "1.1.0" });
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const teach = (t: string) => ({ isError: true, ...text(t) });

  // Tool descriptions teach the order: code → submit; mint → retry.
  server.registerTool(
    "get_feedback_token",
    {
      description:
        "Mint a fresh one-time feedback code. Codes are single-use for writes (submit_feedback consumes one per entry) and expire after 10 minutes; reads never consume a code. Call this whenever submit_feedback reports 'already used'.",
    },
    async () =>
      text(
        JSON.stringify({
          token: createToken(),
          note: "Pass this as submit_feedback's `code` argument. Single-use for writes, 10-minute TTL.",
        })
      )
  );

  server.registerTool(
    "submit_feedback",
    {
      description:
        "Leave feedback for the skill author: source = skill/app name, message = the user's own words, optional rating 1-5, severity, agent_id, base64 screenshot (max 4MB). Uses this connection's one-time code, or pass a fresh one from get_feedback_token as `code`. On 'already used' or 'expired', call get_feedback_token and retry with the new code.",
      inputSchema: z.object({
        source: z.string().describe("Skill or app name, e.g. 'research'"),
        message: z.string().describe("The feedback, in the user's own words"),
        rating: z.number().min(1).max(5).optional().describe("1-5"),
        severity: z.enum(["info", "warning", "error", "suggestion", "bug"]).optional(),
        agent_id: z.string().optional().describe("Name of the agent sending it, e.g. 'pi'"),
        screenshot: z.string().optional().describe("Base64-encoded image, max 4MB"),
        screenshot_mime: z
          .string()
          .optional()
          .describe("image/png (default), image/jpeg, image/webp, image/gif"),
        code: z
          .string()
          .optional()
          .describe("One-time code from get_feedback_token; omit to use this connection's code"),
      }),
    },
    async (args) => {
      const code = typeof args.code === "string" && args.code.trim() ? args.code.trim() : bearer;
      if (!code) {
        return teach(
          "No one-time code available. Connect with `Authorization: Bearer <code>` (mint via POST " +
            `${origin}/token), or call get_feedback_token from an authed connection and pass the result as \`code\`.`
        );
      }
      const row = getToken(code);
      if (!row) {
        return teach(
          "Unknown code. Call get_feedback_token, then call submit_feedback again passing the token it returned as `code`."
        );
      }
      if (isTokenExpired(row.created_at)) {
        return teach(
          "That code expired (10-minute TTL). Call get_feedback_token for a fresh one and pass it as `code`. " +
            `If this connection's own code expired, reconnect: POST ${origin}/token, then send 'Authorization: Bearer <code>'.`
        );
      }
      if (row.used === 1) {
        return teach(
          "That code was already used — codes are single-use for writes. Call get_feedback_token for a fresh one, then call submit_feedback again passing it as `code`."
        );
      }

      const n = normalizeEntry(args);
      if ("error" in n) return teach(n.error);

      const id = addFeedback(n.entry);
      consumeToken(code);
      return text(JSON.stringify({ id }));
    }
  );

  server.registerTool(
    "list_feedback",
    {
      description:
        "List feedback entries, newest first. Optionally filter by source (skill/app name). Never consumes a code.",
      inputSchema: z.object({
        source: z.string().optional().describe("Filter by skill/app name"),
        limit: z.number().min(1).max(200).optional().describe("Max results (default 50)"),
        offset: z.number().min(0).optional().describe("Skip N results for pagination"),
      }),
    },
    async ({ source, limit, offset }) => {
      const rows = listFeedback({ source, limit, offset });
      return text(JSON.stringify(rows, null, 2));
    }
  );

  server.registerTool(
    "get_feedback_screenshot",
    {
      description:
        "Get the screenshot attached to a feedback entry (see list_feedback's has_screenshot flag) as an image.",
      inputSchema: z.object({
        id: z.number().int().describe("Feedback entry id"),
      }),
    },
    async ({ id }) => {
      const shot = getScreenshot(id);
      if (!shot) {
        return text(`No screenshot for feedback #${id}`);
      }
      return {
        content: [
          {
            type: "image" as const,
            data: shot.bytes.toString("base64"),
            mimeType: shot.mime ?? "image/png",
          },
        ],
      };
    }
  );

  return server;
});
