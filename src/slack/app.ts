import boltPkg from '@slack/bolt';
import type { Config } from '../config.js';
import { logger } from '../util/logger.js';

const { App } = boltPkg;
export type BoltApp = InstanceType<typeof App>;

/** Socket Mode for dev/demo (no public URL); HTTP behind SLACK_MODE=http (spec §2). */
export function createSlackApp(config: Config): BoltApp {
  if (config.slackMode === 'http') {
    return new App({
      token: config.slackBotToken,
      signingSecret: config.slackSigningSecret,
      port: config.httpPort,
    });
  }
  return new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });
}

/**
 * Error boundary for every handler (spec Phase 9): a throwing handler must
 * never crash the socket. Logs and swallows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bolt's listener generics vary per surface; the boundary is runtime containment.
export function withBoundary(
  name: string,
  fn: (...args: any[]) => Promise<void>,
): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      logger.error({ err, handler: name }, 'handler failed (contained by boundary)');
    }
  };
}

/** LRU event-id dedupe: Slack retries deliveries; never double-process (spec Phase 9). */
export class EventDeduper {
  private seen = new Set<string>();

  constructor(private capacity = 5000) {}

  /** Returns true the first time an id is seen, false on duplicates. */
  firstTime(id: string | undefined): boolean {
    if (!id) return true; // no id → can't dedupe, let it through
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value as string;
      this.seen.delete(oldest);
    }
    return true;
  }
}

/**
 * Per-key rate gate: serializes callers per key with a minimum interval.
 * Used to keep chat.update ≥1s apart per channel (spec Phase 9).
 */
export class RateGate {
  private lastRun = new Map<string, number>();
  private chains = new Map<string, Promise<void>>();

  constructor(private minIntervalMs = 1000, private nowFn: () => number = Date.now) {}

  async wait(key: string): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    this.chains.set(
      key,
      prev.then(() => current),
    );
    await prev;
    const elapsed = this.nowFn() - (this.lastRun.get(key) ?? 0);
    const delay = Math.max(0, this.minIntervalMs - elapsed);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    this.lastRun.set(key, this.nowFn());
    release();
  }
}
