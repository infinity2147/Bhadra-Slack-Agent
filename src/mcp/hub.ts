/**
 * MCP client hub (spec §8): connects to the three servers on boot, exposes
 * callTool(), and logs the tool inventory at startup. Mock servers are spawned
 * as child processes over stdio when MOCK_MCP=true; real MCP server commands
 * (Datadog, PagerDuty, GitHub) can be swapped in via `serverCommands`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpPort, McpServerName } from '../ports.js';
import { logger } from '../util/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function tsxCommand(serverFile: string): ServerCommand {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve('tsx/cli');
  return { command: process.execPath, args: [tsxCli, join(__dirname, 'servers', serverFile)] };
}

export function mockServerCommands(): Record<McpServerName, ServerCommand> {
  return {
    deploys: tsxCommand('deploys.ts'),
    observability: tsxCommand('observability.ts'),
    oncall: tsxCommand('oncall.ts'),
  };
}

export class McpHub implements McpPort {
  private clients = new Map<McpServerName, Client>();
  private commands: Record<McpServerName, ServerCommand>;
  /** Invoked when the oncall server's `page` tool fires — the hub delivers the DM. */
  onPage?: (user: string, message: string) => Promise<void>;

  constructor(commands: Record<McpServerName, ServerCommand> = mockServerCommands()) {
    this.commands = commands;
  }

  async connectAll(): Promise<void> {
    // Connect each server independently: a single server that fails to spawn
    // (bad command, missing binary when a real MCP server is swapped in) must
    // degrade to "that capability is unavailable" rather than taking the whole
    // hub — and with it deploys + observability + oncall — down with it.
    for (const name of Object.keys(this.commands) as McpServerName[]) {
      const cmd = this.commands[name];
      const client = new Client({ name: `sentinel-hub-${name}`, version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: cmd.command,
        args: cmd.args,
        env: { ...(process.env as Record<string, string>), ...cmd.env },
        stderr: 'ignore',
      });
      try {
        await client.connect(transport);
        this.clients.set(name, client);
      } catch (err) {
        logger.error({ err, server: name }, 'MCP server failed to connect — that capability is unavailable');
      }
    }
    // Tool inventory in the logs — part of the architecture story (spec §8).
    for (const [name, tools] of Object.entries(await this.listAllTools())) {
      logger.info({ server: name, tools }, 'MCP server connected');
    }
  }

  async listAllTools(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const [name, client] of this.clients) {
      const res = await client.listTools();
      out[name] = res.tools.map((t) => t.name);
    }
    return out;
  }

  async callTool(server: McpServerName, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server not connected: ${server}`);
    const res = await client.callTool({ name: tool, arguments: args });
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content.find((c) => c.type === 'text')?.text;
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { text };
      }
    }
    // Page envelope → hub delivers the DM (spec §8.3).
    if (
      server === 'oncall' &&
      tool === 'page' &&
      this.onPage &&
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { action?: string }).action === 'page'
    ) {
      const p = parsed as { user: string; message: string };
      await this.onPage(p.user, p.message).catch((err) => logger.warn({ err }, 'page DM failed'));
    }
    return parsed;
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close().catch(() => {});
    }
    this.clients.clear();
  }
}
