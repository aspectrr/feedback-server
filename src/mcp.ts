import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { listFeedback } from "./db";

// MCP server for agents to read feedback. Mounted at /mcp behind ADMIN_KEY.
export const mcpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: "feedback", version: "1.0.0" });

  server.registerTool(
    "list_feedback",
    {
      description:
        "List feedback entries, newest first. Optionally filter by source (skill/app name).",
      inputSchema: z.object({
        source: z.string().optional().describe("Filter by skill/app name"),
        limit: z.number().min(1).max(200).optional().describe("Max results (default 50)"),
        offset: z.number().min(0).optional().describe("Skip N results for pagination"),
      }),
    },
    async ({ source, limit, offset }) => {
      const rows = listFeedback({ source, limit, offset });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
      };
    }
  );

  return server;
});
