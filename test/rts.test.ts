import { describe, expect, it, vi } from 'vitest';
import { RtsClient, type SlackWebLike } from '../src/rts/client.js';

/** A fake WebClient where search.messages fails but conversations.history works. */
function fakeWeb(rtsFails: () => boolean): { web: SlackWebLike; searchCalls: () => number } {
  let searchCalls = 0;
  const web: SlackWebLike = {
    async apiCall(method, _options) {
      if (method === 'search.messages') {
        searchCalls++;
        if (rtsFails()) throw new Error('missing_scope');
        return { ok: true, messages: { matches: [{ ts: '9.0', text: 'live hit', user: 'U1', channel: { id: 'C1' } }] } };
      }
      // conversations.history fallback
      return { ok: true, messages: [{ ts: '5.0', text: 'timeout on checkout', user: 'U2' }] };
    },
  };
  return { web, searchCalls: () => searchCalls };
}

describe('RtsClient re-probe', () => {
  it('re-probes RTS after the cooldown instead of downgrading forever', async () => {
    let clock = 1_000_000;
    let broken = true;
    const { web, searchCalls } = fakeWeb(() => broken);
    const rts = new RtsClient(web, { reprobeMs: 60_000, clock: () => clock });

    // 1st call: RTS fails → history fallback. RTS was attempted once.
    const a = await rts.searchMessages({ query: 'timeout', channels: ['C1'] });
    expect(a[0].text).toBe('timeout on checkout');
    expect(searchCalls()).toBe(1);

    // Within the cooldown: no re-probe, straight to history.
    clock += 30_000;
    await rts.searchMessages({ query: 'timeout', channels: ['C1'] });
    expect(searchCalls()).toBe(1);

    // After the cooldown: re-probe. RTS is healthy again now → real path returns.
    clock += 40_000; // total 70s > 60s cooldown
    broken = false;
    const c = await rts.searchMessages({ query: 'timeout', channels: ['C1'] });
    expect(searchCalls()).toBe(2);
    expect(c[0].text).toBe('live hit');

    // Recovered: subsequent calls use RTS directly with no extra history hop.
    const d = await rts.searchMessages({ query: 'timeout', channels: ['C1'] });
    expect(searchCalls()).toBe(3);
    expect(d[0].text).toBe('live hit');
  });
});
