/**
 * Live cost meter (spec §6.6): cost = rate_per_min(service) × minutes × severity multiplier.
 * Ticks the war-room header every 60s via the queued chat.update path.
 */
import { getConfigValue, getIncident, updateIncident, type Database, type Severity } from '../db/index.js';
import type { IncidentCore } from './incident.js';
import { logger } from '../util/logger.js';
import { now } from '../util/time.js';

const SEVERITY_MULTIPLIER: Record<Severity, number> = {
  SEV1: 1.0,
  SEV2: 0.4,
  SEV3: 0.1,
  SEV4: 0.05,
};

export function estimateCost(opts: {
  ratePerMin: number;
  startedAt: number;
  nowTs: number;
  severity: Severity | null;
}): number {
  const minutes = Math.max(0, (opts.nowTs - opts.startedAt) / 60);
  const mult = opts.severity ? SEVERITY_MULTIPLIER[opts.severity] : SEVERITY_MULTIPLIER.SEV2;
  return opts.ratePerMin * minutes * mult;
}

/** Per-service rate from `/incident config cost <svc> <n>`, else the env default. */
export function ratePerMinFor(db: Database, service: string | null, defaultRate: number): number {
  if (service) {
    const v = getConfigValue(db, `cost:${service.toLowerCase()}`);
    if (v && !Number.isNaN(parseFloat(v))) return parseFloat(v);
  }
  return defaultRate;
}

export class CostMeter {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: Database,
    private core: IncidentCore,
    private opts: { defaultRatePerMin: number; tickSeconds?: number },
  ) {}

  get running(): string[] {
    return [...this.timers.keys()];
  }

  start(incidentId: string): void {
    if (this.timers.has(incidentId)) return;
    const interval = setInterval(() => {
      void this.tick(incidentId).catch((err) => logger.warn({ err, incidentId }, 'cost tick failed'));
    }, (this.opts.tickSeconds ?? 60) * 1000);
    interval.unref?.();
    this.timers.set(incidentId, interval);
  }

  stop(incidentId: string): void {
    const t = this.timers.get(incidentId);
    if (t) clearInterval(t);
    this.timers.delete(incidentId);
  }

  /** One meter update; exposed for tests and for an immediate post-declare tick. */
  async tick(incidentId: string): Promise<number> {
    const inc = getIncident(this.db, incidentId);
    if (!inc) {
      this.stop(incidentId);
      return 0;
    }
    if (inc.status === 'resolved' || inc.status === 'postmortem_done') {
      this.stop(incidentId);
      return inc.cost_estimate_usd;
    }
    const cost = estimateCost({
      ratePerMin: ratePerMinFor(this.db, inc.service, this.opts.defaultRatePerMin),
      startedAt: inc.started_at,
      nowTs: now(),
      severity: inc.severity,
    });
    updateIncident(this.db, incidentId, { cost_estimate_usd: cost });
    await this.core.refreshHeader(incidentId, cost);
    return cost;
  }
}
