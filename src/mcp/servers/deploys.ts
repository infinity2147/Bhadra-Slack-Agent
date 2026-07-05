/**
 * Mock "deploys" MCP server (spec §8.1). Stdio transport, in-memory state.
 * Stands in for a GitHub/CD MCP server; swap the real one in via config.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

interface Deploy {
  id: string;
  service: string;
  title: string;
  author: string;
  deployed_at: number; // epoch seconds
  diff: string;
  url: string;
}

const nowS = () => Math.floor(Date.now() / 1000);

const deploys: Deploy[] = [
  {
    id: '#479',
    service: 'auth-svc',
    title: 'chore: bump jwt lib',
    author: 'mia',
    deployed_at: nowS() - 6 * 3600,
    diff: '+ jwt@9.1.0\n- jwt@9.0.2',
    url: 'https://git.example.com/deploys/479',
  },
  {
    id: '#480',
    service: 'search-svc',
    title: 'feat: fuzzy matching',
    author: 'lee',
    deployed_at: nowS() - 4 * 3600,
    diff: '+ fuzzy_match(query, 0.8)',
    url: 'https://git.example.com/deploys/480',
  },
  {
    id: '#481',
    service: 'checkout-svc',
    title: 'refactor: cart session cache',
    author: 'sam',
    deployed_at: nowS() - 2 * 3600,
    diff: '+ cache.set(session_id, cart, ttl=300)',
    url: 'https://git.example.com/deploys/481',
  },
];

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const server = new McpServer({ name: 'mock-deploys', version: '1.0.0' });

server.registerTool(
  'list_recent_deploys',
  {
    description: 'List deploys in the last N minutes, optionally filtered by service.',
    inputSchema: { service: z.string().optional(), minutes: z.number().default(60) },
  },
  async ({ service, minutes }) => {
    const cutoff = nowS() - minutes * 60;
    const out = deploys
      .filter((d) => d.deployed_at >= cutoff)
      .filter((d) => !service || d.service.toLowerCase().includes(service.toLowerCase()))
      .map(({ diff: _diff, ...rest }) => rest);
    return json({ deploys: out });
  },
);

server.registerTool(
  'get_deploy_diff',
  {
    description: 'Get the diff for a deploy by id.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const d = deploys.find((x) => x.id === id);
    return json(d ? { id: d.id, title: d.title, diff: d.diff, url: d.url } : { error: `no deploy ${id}` });
  },
);

server.registerTool(
  'seed_deploy',
  {
    description: 'Seed a deploy (used by chaos drills).',
    inputSchema: {
      id: z.string().optional(),
      service: z.string(),
      title: z.string(),
      author: z.string(),
      minutes_ago: z.number().default(2),
      diff: z.string().optional(),
    },
  },
  async ({ id, service, title, author, minutes_ago, diff }) => {
    const deploy: Deploy = {
      id: id ?? `#${482 + deploys.length - 3}`,
      service,
      title,
      author,
      deployed_at: nowS() - minutes_ago * 60,
      diff: diff ?? '+ pool.max_connections = 128',
      url: `https://git.example.com/deploys/${(id ?? '#482').replace('#', '')}`,
    };
    deploys.push(deploy);
    return json({ seeded: deploy });
  },
);

await server.connect(new StdioServerTransport());
