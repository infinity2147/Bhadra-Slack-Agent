/**
 * Seed historical incidents + embeddings (spec §11). Run: npm run seed
 * Resolver IDs map to real workspace users via SEED_RESOLVER_* env vars.
 */
import { config } from '../src/config.js';
import { insertIncident, openDb, updateIncident, getIncident, type Incident } from '../src/db/index.js';
import { MemoryEngine } from '../src/engine/memory.js';
import { logger } from '../src/util/logger.js';

const SAM = process.env.SEED_RESOLVER_SAM ?? 'USAM';
const DANA = process.env.SEED_RESOLVER_DANA ?? 'UDANA';
const MIA = process.env.SEED_RESOLVER_MIA ?? 'UMIA';
const LEE = process.env.SEED_RESOLVER_LEE ?? 'ULEE';

function at(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

interface SeedRow {
  id: string;
  title: string;
  service: string;
  severity: Incident['severity'];
  started: string;
  minutes: number;
  cost: number;
  resolver: string;
  summary: string;
  root_cause: string;
  resolution: string;
}

const SEEDS: SeedRow[] = [
  {
    // Flagship for the demo line: "This looks 83% similar to INC-042" (spec §11).
    id: 'INC-042',
    title: 'Redis connection pool exhaustion during checkout deploy',
    service: 'checkout',
    severity: 'SEV2',
    started: '2026-03-12T14:03:00Z',
    minutes: 22,
    cost: 3960,
    resolver: SAM,
    summary:
      'Checkout latency spiked and requests timed out after a checkout-svc deploy; the Redis connection pool was exhausted, slowing cart and payment confirmation for ~22 minutes.',
    root_cause:
      'The new session cache code opened a Redis connection per request while the pool max_connections stayed at 128; under checkout traffic the pool exhausted and requests queued. The deploy pipeline lacked a connection-count canary.',
    resolution: 'Restarted the Redis connection pool and raised max_connections 128→512; added pool saturation alerting.',
  },
  {
    id: 'INC-038',
    title: 'Payments DB primary failover stall',
    service: 'payments',
    severity: 'SEV1',
    started: '2026-02-02T09:40:00Z',
    minutes: 51,
    cost: 18360,
    resolver: MIA,
    summary: 'Payment authorizations failed for 51 minutes when the payments Postgres primary stalled and automatic failover did not trigger.',
    root_cause: 'Failover health checks only watched TCP liveness, not query latency, so a wedged-but-alive primary never failed over.',
    resolution: 'Manually promoted the replica; failover checks now include query-latency probes.',
  },
  {
    id: 'INC-040',
    title: 'Auth token validation errors after JWT library deploy',
    service: 'auth',
    severity: 'SEV2',
    started: '2026-02-25T17:12:00Z',
    minutes: 34,
    cost: 4080,
    resolver: MIA,
    summary: 'Roughly 30% of logins failed with 401s after an auth-svc deploy bumped the JWT library, which changed default clock-skew tolerance.',
    root_cause: 'The library upgrade changed validation defaults; the deploy lacked a canary on auth success rate.',
    resolution: 'Rolled back the deploy, then re-shipped with explicit clock-skew configuration.',
  },
  {
    id: 'INC-041',
    title: 'Search cluster ES shard relocation storm',
    service: 'search',
    severity: 'SEV3',
    started: '2026-03-03T11:20:00Z',
    minutes: 63,
    cost: 1890,
    resolver: LEE,
    summary: 'Search queries were slow (p95 > 4s) for an hour while Elasticsearch relocated shards after a node was replaced mid-day.',
    root_cause: 'Shard relocation throttles were tuned for overnight maintenance windows, not daytime node replacement.',
    resolution: 'Throttled relocation bandwidth and moved node replacement to a low-traffic window.',
  },
  {
    id: 'INC-043',
    title: 'Cart service memory leak causing rolling restarts',
    service: 'checkout',
    severity: 'SEV3',
    started: '2026-04-08T20:05:00Z',
    minutes: 95,
    cost: 2850,
    resolver: DANA,
    summary: 'Cart pods OOM-restarted in a rolling pattern for ~90 minutes, causing intermittent cart errors and slow checkout.',
    root_cause: 'A new in-memory cart cache had no TTL eviction; memory limits were hit under evening traffic.',
    resolution: 'Shipped a TTL eviction fix and raised pod memory limits as interim mitigation.',
  },
  {
    id: 'INC-044',
    title: 'Payment webhook backlog from provider slowdown',
    service: 'payments',
    severity: 'SEV3',
    started: '2026-05-11T13:45:00Z',
    minutes: 78,
    cost: 2340,
    resolver: SAM,
    summary: 'Payment confirmation webhooks queued up for over an hour when the upstream provider slowed, delaying order confirmation emails.',
    root_cause: 'Webhook workers processed serially per merchant with no backpressure signal to the queue autoscaler.',
    resolution: 'Scaled webhook workers 4x and added queue-depth-based autoscaling.',
  },
  {
    id: 'INC-045',
    title: 'Auth deploy broke SSO redirect loop',
    service: 'auth',
    severity: 'SEV2',
    started: '2026-06-01T08:15:00Z',
    minutes: 27,
    cost: 3240,
    resolver: DANA,
    summary: 'Enterprise SSO users hit a redirect loop for ~27 minutes after an auth-svc deploy changed the callback path.',
    root_cause: 'The callback route change was not covered by SSO integration tests, and the deploy lacked a staged rollout.',
    resolution: 'Rolled back the route change; added SSO callback smoke tests to the deploy gate.',
  },
];

async function main(): Promise<void> {
  const db = openDb(config.dbPath);
  const memory = new MemoryEngine(db, null);
  let seeded = 0;
  for (const row of SEEDS) {
    if (getIncident(db, row.id)) {
      logger.info({ id: row.id }, 'seed exists; refreshing embedding only');
    } else {
      const started = at(row.started);
      insertIncident(db, {
        id: row.id,
        title: row.title,
        status: 'postmortem_done',
        severity: row.severity,
        service: row.service,
        channel_id: null,
        triage_thread_ts: null,
        commander_user_id: row.resolver,
        comms_user_id: null,
        scribe_user_id: null,
        started_at: started,
        detected_at: started,
        resolved_at: started + row.minutes * 60,
        cost_estimate_usd: row.cost,
        is_drill: 0,
        summary: row.summary,
        root_cause: row.root_cause,
        resolution: row.resolution,
        postmortem_doc: `# Postmortem: ${row.id} — ${row.title}\n\n## Summary\n${row.summary}\n\n## Root cause\n${row.root_cause}\n\n## Resolution\n${row.resolution}\n`,
      });
      seeded++;
    }
    updateIncident(db, row.id, {});
    await memory.indexIncident(getIncident(db, row.id)!);
  }
  logger.info({ seeded, total: SEEDS.length, db: config.dbPath }, 'seed complete (incidents + embeddings)');
}

await main();
