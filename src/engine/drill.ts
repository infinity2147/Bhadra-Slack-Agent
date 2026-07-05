/**
 * Chaos drill mode (spec §6.8): seeds a fake deploy into the mock MCP deploys
 * server, elevates mock observability metrics, then posts 🎭 DRILL trouble
 * messages that flow through the REAL Signal Engine end-to-end. This is both
 * the training feature and the demo recording mechanism (spec §11).
 */
import type { McpPort, SlackPort } from '../ports.js';
import type { SignalEngine } from './signals.js';
import { logger } from '../util/logger.js';

export type ScenarioName = 'redis' | 'deploy' | 'db' | 'payment';

export interface DrillScenario {
  service: string;
  deploy: { id: string; service: string; title: string; author: string; minutes_ago: number; diff?: string };
  /** Posted in order with delays; each simulates a distinct reporter. */
  messages: { text: string; delayMs: number }[];
}

export const SCENARIOS: Record<ScenarioName, DrillScenario> = {
  // The flagship 3-minute demo arc (spec §11).
  redis: {
    service: 'checkout',
    deploy: {
      id: '#482',
      service: 'checkout-svc',
      title: 'fix: connection pooling',
      author: 'dana',
      minutes_ago: 14,
      diff: '+ pool = RedisPool(max_connections=128)\n- pool = RedisPool(max_connections=64)',
    },
    messages: [
      { text: '🎭 DRILL: checkout feels slow?', delayMs: 0 },
      { text: '🎭 DRILL: yeah seeing timeouts', delayMs: 20_000 },
      { text: '🎭 DRILL: 500s on /cart', delayMs: 20_000 },
    ],
  },
  deploy: {
    service: 'auth',
    deploy: { id: '#483', service: 'auth-svc', title: 'feat: new session middleware', author: 'mia', minutes_ago: 8 },
    messages: [
      { text: '🎭 DRILL: is it just me or are logins failing?', delayMs: 0 },
      { text: '🎭 DRILL: getting 401 errors after the auth deploy', delayMs: 15_000 },
      { text: '🎭 DRILL: SSO redirect seems broken too', delayMs: 15_000 },
    ],
  },
  db: {
    service: 'payments',
    deploy: { id: '#484', service: 'payments-svc', title: 'chore: connection string rotation', author: 'lee', minutes_ago: 10 },
    messages: [
      { text: '🎭 DRILL: payments dashboard looks weird, queries timing out', delayMs: 0 },
      { text: '🎭 DRILL: seeing db connection errors in payments logs', delayMs: 15_000 },
      { text: '🎭 DRILL: payment authorizations failing for me', delayMs: 15_000 },
    ],
  },
  payment: {
    service: 'payments',
    deploy: { id: '#485', service: 'payments-svc', title: 'feat: new provider webhook', author: 'sam', minutes_ago: 5 },
    messages: [
      { text: '🎭 DRILL: anyone else seeing payment confirmations stuck?', delayMs: 0 },
      { text: '🎭 DRILL: webhook queue is backing up, orders not confirming', delayMs: 15_000 },
      { text: '🎭 DRILL: customers reporting failed checkouts on payment step', delayMs: 15_000 },
    ],
  },
};

export function isDrillSignalUser(userId: string | null): boolean {
  return !!userId && userId.startsWith('drill-');
}

export class DrillEngine {
  constructor(
    private slack: SlackPort,
    private signals: SignalEngine,
    private mcp?: McpPort,
    /** Speed multiplier for tests/demos: 0 collapses all delays. */
    private delayScale = 1,
  ) {}

  async run(name: ScenarioName, channelId: string): Promise<void> {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown drill scenario: ${name}`);

    if (this.mcp) {
      try {
        await this.mcp.callTool('deploys', 'seed_deploy', { ...scenario.deploy });
        await this.mcp.callTool('observability', 'set_drill_mode', { on: true });
      } catch (err) {
        logger.warn({ err }, 'drill MCP seeding failed; continuing');
      }
    }

    await this.slack.postMessage({
      channel: channelId,
      text: `🎭 *Chaos drill started* — scenario \`${name}\`. Messages below are simulated; everything else (detection, war room, postmortem) is the real pipeline.`,
    });

    for (let i = 0; i < scenario.messages.length; i++) {
      const msg = scenario.messages[i];
      if (msg.delayMs > 0 && this.delayScale > 0) {
        await new Promise((r) => setTimeout(r, msg.delayMs * this.delayScale));
      }
      const posted = await this.slack.postMessage({ channel: channelId, text: msg.text });
      // Feed the real Signal Engine directly with a distinct simulated reporter.
      // (Slack events for our own bot posts are skipped by events.ts; dedupe by
      // message_ts makes double-processing harmless either way.)
      await this.signals.handleMessage({
        channelId,
        ts: posted.ts,
        userId: `drill-${i + 1}`,
        text: msg.text.replace(/^🎭 DRILL:?\s*/i, ''),
      });
    }

    // Snappy demo: cluster immediately instead of waiting for the next poll.
    await this.signals.clusterTick();
  }

  async end(): Promise<void> {
    if (this.mcp) {
      await this.mcp.callTool('observability', 'set_drill_mode', { on: false }).catch(() => {});
    }
  }
}
