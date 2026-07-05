import { afterAll, describe, expect, it } from 'vitest';
import { McpHub, mockServerCommands } from '../src/mcp/hub.js';

// Spawns real child processes over stdio — this is the integration test for §8.
const hub = new McpHub(mockServerCommands());

afterAll(async () => {
  await hub.close();
});

describe('McpHub + mock servers', () => {
  it('connects all three servers and lists their tools', async () => {
    await hub.connectAll();
    const tools = await hub.listAllTools();
    expect(tools.deploys).toContain('list_recent_deploys');
    expect(tools.deploys).toContain('seed_deploy');
    expect(tools.observability).toContain('get_error_rate');
    expect(tools.oncall).toContain('who_is_oncall');
  }, 30_000);

  it('seed_deploy then list_recent_deploys returns the seeded deploy', async () => {
    await hub.callTool('deploys', 'seed_deploy', {
      id: '#482',
      service: 'checkout-svc',
      title: 'fix: connection pooling',
      author: 'dana',
      minutes_ago: 14,
    });
    const res = (await hub.callTool('deploys', 'list_recent_deploys', { minutes: 30 })) as {
      deploys: { id: string; service: string }[];
    };
    expect(res.deploys.some((d) => d.id === '#482' && d.service === 'checkout-svc')).toBe(true);
  }, 30_000);

  it('oncall page triggers the hub DM callback', async () => {
    const pages: { user: string; message: string }[] = [];
    hub.onPage = async (user, message) => {
      pages.push({ user, message });
    };
    await hub.callTool('oncall', 'page', { user: 'USAM', message: 'INC needs you' });
    expect(pages).toEqual([{ user: 'USAM', message: 'INC needs you' }]);
  }, 30_000);

  it('observability drill mode elevates metrics', async () => {
    const before = (await hub.callTool('observability', 'get_error_rate', { service: 'checkout' })) as {
      error_rate_pct: number;
    };
    await hub.callTool('observability', 'set_drill_mode', { on: true });
    const during = (await hub.callTool('observability', 'get_error_rate', { service: 'checkout' })) as {
      error_rate_pct: number;
    };
    expect(during.error_rate_pct).toBeGreaterThan(before.error_rate_pct + 2);
    await hub.callTool('observability', 'set_drill_mode', { on: false });
  }, 30_000);
});
