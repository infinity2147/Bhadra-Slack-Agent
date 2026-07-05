/**
 * Mock "oncall" MCP server (spec §8.3). Stands in for PagerDuty.
 * `page` returns an action envelope; the hub performs the actual Slack DM.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

// Configurable so demo workspaces can map to real users (spec §11).
const fallback = process.env.ONCALL_USER_ID ?? 'U_ONCALL';
const SCHEDULE: Record<string, string> = {
  checkout: process.env.ONCALL_CHECKOUT ?? fallback,
  payments: process.env.ONCALL_PAYMENTS ?? fallback,
  auth: process.env.ONCALL_AUTH ?? fallback,
  search: process.env.ONCALL_SEARCH ?? fallback,
};

const server = new McpServer({ name: 'mock-oncall', version: '1.0.0' });

server.registerTool(
  'who_is_oncall',
  { description: 'Who is on call for a service right now.', inputSchema: { service: z.string() } },
  async ({ service }) => {
    const key = Object.keys(SCHEDULE).find((k) => service.toLowerCase().includes(k));
    return json({ service, user_id: key ? SCHEDULE[key] : fallback, schedule: 'primary' });
  },
);

server.registerTool(
  'page',
  {
    description: 'Page a user with a message. The Sentinel hub delivers the page as a Slack DM.',
    inputSchema: { user: z.string(), message: z.string() },
  },
  async ({ user, message }) => json({ action: 'page', user, message, paged_at: Math.floor(Date.now() / 1000) }),
);

await server.connect(new StdioServerTransport());
