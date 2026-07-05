/**
 * Mock "observability" MCP server (spec §8.2). Returns plausible metrics;
 * elevated numbers while drill mode is on. Stands in for Datadog/Sentry.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

let drillMode = false;

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

// Deterministic-ish plausible numbers (no Math.random seed drama for demos).
function jitter(base: number, spread: number): number {
  const t = Date.now() / 60000;
  return base + Math.abs(Math.sin(t)) * spread;
}

const server = new McpServer({ name: 'mock-observability', version: '1.0.0' });

server.registerTool(
  'get_error_rate',
  { description: 'Current 5xx error rate (%) for a service.', inputSchema: { service: z.string() } },
  async ({ service }) => {
    const rate = drillMode ? jitter(9.5, 4) : jitter(0.2, 0.3);
    return json({ service, error_rate_pct: Number(rate.toFixed(2)), window: '5m' });
  },
);

server.registerTool(
  'get_latency_p95',
  { description: 'Current p95 latency (ms) for a service.', inputSchema: { service: z.string() } },
  async ({ service }) => {
    const ms = drillMode ? jitter(3800, 900) : jitter(220, 60);
    return json({ service, latency_p95_ms: Math.round(ms), window: '5m' });
  },
);

server.registerTool(
  'get_dashboard_url',
  { description: 'Deep link to the service dashboard.', inputSchema: { service: z.string() } },
  async ({ service }) => json({ service, url: `https://observability.example.com/d/${service}` }),
);

server.registerTool(
  'set_drill_mode',
  { description: 'Toggle elevated drill metrics (used by chaos drills).', inputSchema: { on: z.boolean() } },
  async ({ on }) => {
    drillMode = on;
    return json({ drill_mode: drillMode });
  },
);

await server.connect(new StdioServerTransport());
