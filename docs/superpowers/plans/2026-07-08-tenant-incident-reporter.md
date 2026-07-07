# Tenant Incident Reporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a vendor's customers ("tenants") report problems by @mentioning the bot in their Slack Connect channel; Sentinel classifies each report against admin-configured routing rules, posts a triage card to the right internal team channel, acknowledges the customer, and (on declare/resolve) loops customer-safe updates back to the customer's thread.

**Architecture:** A new `ReporterEngine` owns tenant resolution (cached channel→tenant map), LLM routing (new prompt P9 with keyword/default fallback), the report lifecycle, and customer-safe loop-back. Reports reuse the existing `preincident:<key>` record + `declare_incident` action so declaring from a tenant report builds a normal war room. New `/incident tenant …` admin subcommands manage the registry from internal channels. Three new SQLite tables.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3, zod, Slack Bolt, vitest. Matches the existing Sentinel IC codebase in `sentinel-ic/`.

## Global Constraints (from spec)

- Customer trigger is **`app_mention` only** — external users cannot use slash commands or buttons over Slack Connect. Admin `/incident tenant …` commands run in **internal** channels only.
- Messages posted into a tenant channel must be **customer-safe**: never contain an internal channel id/name, a war-room link, a cost figure, or an internal user id.
- **Event-driven only** — no `conversations.history` polling. Tenant identity resolves from the channel id via an in-process cache populated from the DB.
- Report IDs: `TR-YYYYMMDD-XXX` (mirror the incident-id scheme).
- Severity is a **suggestion** a human confirms; declaring stays a human button click (no auto-declare).
- The LLM's returned route is untrusted: coerce any route not in the tenant's rule keys (or `"default"`) to the default channel. Never post to a raw channel id from the model.
- All new Slack handlers wrapped in `withBoundary`; a routing failure falls back to the tenant's default channel, never a dropped report.
- Reuse existing helpers: `nextIncidentId`-style id generation (`src/util/time.ts` `dateStamp`), `getConfigValue`/`setConfigValue`, `PreIncidentRecord` + `declare_incident` action, `IncidentCore.declare`, `core.onResolved` hook.

---

## File Structure

- Create `src/engine/reporter.ts` — ReporterEngine: resolution, routing, lifecycle, loop-back.
- Create `src/slack/blocks/tenantReport.ts` — triage card blocks for the internal channel.
- Create `test/reporter.test.ts` — routing, registry, lifecycle, customer-safe assertions.
- Modify `src/db/schema.sql` — add `tenants`, `tenant_routing_rules`, `tenant_reports`.
- Modify `src/db/index.ts` — row types + query helpers.
- Modify `src/llm/prompts.ts` — add P9 `routeTenantReport`.
- Modify `src/slack/actions.ts` — extend `PreIncidentRecord` with `tenantReportId`; loop-back on declare; add `decline_report` action.
- Modify `src/slack/commands.ts` — `/incident tenant …` subcommands.
- Modify `src/slack/events.ts` — `app_mention` branches to reporter when in a tenant channel.
- Modify `src/context.ts` — add `reporter: ReporterEngine`.
- Modify `src/index.ts` — construct ReporterEngine, load cache, wire `onResolved`.

---

### Task 1: DB layer for tenants, rules, and reports

**Files:**
- Modify: `src/db/schema.sql` (append three tables)
- Modify: `src/db/index.ts` (row types + query helpers)
- Test: `test/reporter.test.ts` (DB section)

**Interfaces:**
- Consumes: `openDb`, `Database`, `Severity`, `dateStamp` (from `src/util/time.ts`).
- Produces:
  - Types `Tenant`, `TenantRoutingRule`, `TenantReport` (shapes below).
  - `insertTenant(db, t: Tenant): void`
  - `getTenant(db, id): Tenant | undefined`
  - `getTenantByChannel(db, channelId): Tenant | undefined`
  - `listTenants(db): Tenant[]`
  - `removeTenant(db, id): void` (also deletes its rules)
  - `insertRoutingRule(db, r: {tenant_id, target_channel_id, description, created_at}): number`
  - `rulesForTenant(db, tenantId): TenantRoutingRule[]`
  - `nextTenantReportId(db, dateStamp): string`  → `TR-YYYYMMDD-001`
  - `insertTenantReport(db, r: TenantReport): void`
  - `getTenantReport(db, id): TenantReport | undefined`
  - `updateTenantReport(db, id, patch: Partial<TenantReport>): void`
  - `tenantReportsForIncident(db, incidentId): TenantReport[]`

- [ ] **Step 1: Append tables to `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  slack_team_id TEXT,
  tier TEXT,
  default_channel_id TEXT NOT NULL,
  extra_prompt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_routing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  target_channel_id TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reporter_user_id TEXT,
  report_text TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  source_thread_ts TEXT NOT NULL,
  routed_channel_id TEXT,
  category TEXT,
  severity_suggestion TEXT,
  status TEXT NOT NULL,
  incident_id TEXT,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing test** — append to a new `test/reporter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  openDb,
  insertTenant, getTenant, getTenantByChannel, listTenants, removeTenant,
  insertRoutingRule, rulesForTenant,
  nextTenantReportId, insertTenantReport, getTenantReport, updateTenantReport,
  tenantReportsForIncident,
  type Tenant, type TenantReport,
} from '../src/db/index.js';

function tenant(id: string, channelId: string): Tenant {
  return {
    id, name: id.toUpperCase(), channel_id: channelId, slack_team_id: null,
    tier: 'enterprise', default_channel_id: 'C_default', extra_prompt: null, created_at: 1000,
  };
}

describe('tenant DB layer', () => {
  it('stores and resolves tenants by id and channel', () => {
    const db = openDb();
    insertTenant(db, tenant('acme', 'C_acme'));
    expect(getTenant(db, 'acme')!.name).toBe('ACME');
    expect(getTenantByChannel(db, 'C_acme')!.id).toBe('acme');
    expect(getTenantByChannel(db, 'C_missing')).toBeUndefined();
    expect(listTenants(db).map((t) => t.id)).toEqual(['acme']);
  });

  it('stores routing rules and removes tenant + its rules', () => {
    const db = openDb();
    insertTenant(db, tenant('acme', 'C_acme'));
    insertRoutingRule(db, { tenant_id: 'acme', target_channel_id: 'C_pay', description: 'payments billing', created_at: 1 });
    expect(rulesForTenant(db, 'acme')).toHaveLength(1);
    removeTenant(db, 'acme');
    expect(getTenant(db, 'acme')).toBeUndefined();
    expect(rulesForTenant(db, 'acme')).toHaveLength(0);
  });

  it('generates sequential report ids and tracks report lifecycle', () => {
    const db = openDb();
    insertTenant(db, tenant('acme', 'C_acme'));
    expect(nextTenantReportId(db, '20260708')).toBe('TR-20260708-001');
    const report: TenantReport = {
      id: 'TR-20260708-001', tenant_id: 'acme', reporter_user_id: 'UEXT',
      report_text: 'payments failing', source_channel_id: 'C_acme', source_thread_ts: '9.9',
      routed_channel_id: 'C_pay', category: 'payments', severity_suggestion: 'SEV2',
      status: 'routed', incident_id: null, created_at: 5,
    };
    insertTenantReport(db, report);
    expect(nextTenantReportId(db, '20260708')).toBe('TR-20260708-002');
    updateTenantReport(db, report.id, { status: 'linked_incident', incident_id: 'INC-20260708-001' });
    expect(getTenantReport(db, report.id)!.status).toBe('linked_incident');
    expect(tenantReportsForIncident(db, 'INC-20260708-001').map((r) => r.id)).toEqual(['TR-20260708-001']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `npx vitest run test/reporter.test.ts` → FAIL (exports not defined).

- [ ] **Step 4: Add types + helpers to `src/db/index.ts`** (place near the other row types / helpers):

```ts
export interface Tenant {
  id: string;
  name: string;
  channel_id: string;
  slack_team_id: string | null;
  tier: string | null;
  default_channel_id: string;
  extra_prompt: string | null;
  created_at: number;
}

export interface TenantRoutingRule {
  id: number;
  tenant_id: string;
  target_channel_id: string;
  description: string;
  created_at: number;
}

export interface TenantReport {
  id: string;
  tenant_id: string;
  reporter_user_id: string | null;
  report_text: string;
  source_channel_id: string;
  source_thread_ts: string;
  routed_channel_id: string | null;
  category: string | null;
  severity_suggestion: string | null;
  status: string; // routed | declined | linked_incident
  incident_id: string | null;
  created_at: number;
}

export function insertTenant(db: Database, t: Tenant): void {
  db.prepare(
    `INSERT INTO tenants (id, name, channel_id, slack_team_id, tier, default_channel_id, extra_prompt, created_at)
     VALUES (@id, @name, @channel_id, @slack_team_id, @tier, @default_channel_id, @extra_prompt, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, channel_id=excluded.channel_id, slack_team_id=excluded.slack_team_id,
       tier=excluded.tier, default_channel_id=excluded.default_channel_id, extra_prompt=excluded.extra_prompt`,
  ).run(t as unknown as Record<string, unknown>);
}

export function getTenant(db: Database, id: string): Tenant | undefined {
  return db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(id) as Tenant | undefined;
}

export function getTenantByChannel(db: Database, channelId: string): Tenant | undefined {
  return db.prepare(`SELECT * FROM tenants WHERE channel_id = ?`).get(channelId) as Tenant | undefined;
}

export function listTenants(db: Database): Tenant[] {
  return db.prepare(`SELECT * FROM tenants ORDER BY id ASC`).all() as Tenant[];
}

export function removeTenant(db: Database, id: string): void {
  const tx = db.transaction((tid: string) => {
    db.prepare(`DELETE FROM tenant_routing_rules WHERE tenant_id = ?`).run(tid);
    db.prepare(`DELETE FROM tenants WHERE id = ?`).run(tid);
  });
  tx(id);
}

export function insertRoutingRule(
  db: Database,
  r: { tenant_id: string; target_channel_id: string; description: string; created_at: number },
): number {
  const res = db
    .prepare(`INSERT INTO tenant_routing_rules (tenant_id, target_channel_id, description, created_at) VALUES (?, ?, ?, ?)`)
    .run(r.tenant_id, r.target_channel_id, r.description, r.created_at);
  return Number(res.lastInsertRowid);
}

export function rulesForTenant(db: Database, tenantId: string): TenantRoutingRule[] {
  return db.prepare(`SELECT * FROM tenant_routing_rules WHERE tenant_id = ? ORDER BY id ASC`).all(tenantId) as TenantRoutingRule[];
}

export function nextTenantReportId(db: Database, dateStamp: string): string {
  const prefix = `TR-${dateStamp}-`;
  const row = db
    .prepare(`SELECT id FROM tenant_reports WHERE id LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}%`) as { id: string } | undefined;
  const n = row ? parseInt(row.id.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(3, '0')}`;
}

export function insertTenantReport(db: Database, r: TenantReport): void {
  db.prepare(
    `INSERT INTO tenant_reports (id, tenant_id, reporter_user_id, report_text, source_channel_id,
       source_thread_ts, routed_channel_id, category, severity_suggestion, status, incident_id, created_at)
     VALUES (@id, @tenant_id, @reporter_user_id, @report_text, @source_channel_id,
       @source_thread_ts, @routed_channel_id, @category, @severity_suggestion, @status, @incident_id, @created_at)`,
  ).run(r as unknown as Record<string, unknown>);
}

export function getTenantReport(db: Database, id: string): TenantReport | undefined {
  return db.prepare(`SELECT * FROM tenant_reports WHERE id = ?`).get(id) as TenantReport | undefined;
}

export function updateTenantReport(db: Database, id: string, patch: Partial<TenantReport>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tenant_reports SET ${sets} WHERE id = @id`).run({ ...patch, id } as Record<string, unknown>);
}

export function tenantReportsForIncident(db: Database, incidentId: string): TenantReport[] {
  return db.prepare(`SELECT * FROM tenant_reports WHERE incident_id = ? ORDER BY id ASC`).all(incidentId) as TenantReport[];
}
```

- [ ] **Step 5: Run test to verify it passes** — `npx vitest run test/reporter.test.ts` → PASS (3 tests). Then `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/index.ts test/reporter.test.ts
git commit -m "feat: tenant/report DB layer for incident reporter"
```

---

### Task 2: P9 router prompt + ReporterEngine routing

**Files:**
- Modify: `src/llm/prompts.ts` (add `routeTenantReport`)
- Create: `src/engine/reporter.ts` (routing portion)
- Test: `test/reporter.test.ts` (routing section)

**Interfaces:**
- Consumes: `LlmClient` (`completeJson`), `Tenant`, `TenantRoutingRule`, `rulesForTenant`, `getTenantByChannel`, `Database`, `SlackPort`.
- Produces:
  - Prompt `routeTenantReport` = `{ temperature: 0.2, schema, system, buildUser(text, tenantName, tier, rules: {key,description}[], extraPrompt) }` returning `{ route: string, category: string, severity_suggestion: 'SEV1'|'SEV2'|'SEV3'|'SEV4', summary: string }`.
  - `class ReporterEngine` with (this task) `constructor(db, slack, llm, opts?)`, `loadCache()`, `registerTenantChannel(channelId, tenantId)`, `unregister(tenantId)`, `isTenantChannel(channelId): boolean`, `tenantForChannel(channelId): Tenant | undefined`, and `route(tenant, text): Promise<{ targetChannelId: string; category: string; severity: Severity; summary: string }>`.

- [ ] **Step 1: Add P9 to `src/llm/prompts.ts`**

```ts
export const routeTenantReport = {
  temperature: 0.2,
  schema: z.object({
    route: z.string(),
    category: z.string(),
    severity_suggestion: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']),
    summary: z.string(),
  }),
  system: `You route a customer's problem report to the correct internal team for a SaaS vendor.

You are given the customer's message, the customer's account name/tier, and a numbered list of routing rules — each with a KEY and a plain-language description of what it covers. Choose the single best-matching rule KEY. If nothing clearly matches, return "default".

Also return: category (a short lowercase label like "payments", "auth", "performance"), severity_suggestion (SEV1 total outage / SEV2 major degradation / SEV3 partial / SEV4 minor — this is only a suggestion a human confirms; enterprise-tier accounts may warrant one level higher), and summary (one crisp sentence restating the problem for the internal team).

Respond ONLY with JSON, no markdown fences. Shape: {"route":"r2","category":"payments","severity_suggestion":"SEV2","summary":"..."}`,
  buildUser(
    text: string,
    tenantName: string,
    tier: string | null,
    rules: { key: string; description: string }[],
    extraPrompt: string | null,
  ): string {
    const ruleLines = rules.map((r) => `- ${r.key}: ${r.description}`).join('\n') || '(no rules; use "default")';
    return `Customer: ${tenantName}${tier ? ` (tier: ${tier})` : ''}\n${extraPrompt ? `Special guidance: ${extraPrompt}\n` : ''}\nRouting rules:\n${ruleLines}\n- default: anything not matching a rule above\n\nCustomer report:\n${text}`;
  },
};
```

- [ ] **Step 2: Write the failing test** (append to `test/reporter.test.ts`; note the fakes reuse `test/helpers/fakes.ts`):

```ts
import { ReporterEngine } from '../src/engine/reporter.js';
import { LlmClient } from '../src/llm/client.js';
import { FakeSlack } from './helpers/fakes.js';

function seededDb() {
  const db = openDb();
  insertTenant(db, { ...tenant('acme', 'C_acme'), default_channel_id: 'C_triage' });
  insertRoutingRule(db, { tenant_id: 'acme', target_channel_id: 'C_pay', description: 'payments, billing, refunds, invoices', created_at: 1 });
  insertRoutingRule(db, { tenant_id: 'acme', target_channel_id: 'C_platform', description: 'login, SSO, access, authentication', created_at: 2 });
  return db;
}

describe('ReporterEngine.route', () => {
  it('resolves tenants by channel via the cache', () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null);
    eng.loadCache();
    expect(eng.isTenantChannel('C_acme')).toBe(true);
    expect(eng.isTenantChannel('C_other')).toBe(false);
    expect(eng.tenantForChannel('C_acme')!.id).toBe('acme');
  });

  it('routes via the LLM when available', async () => {
    const db = seededDb();
    const llm = new LlmClient({
      model: 'test',
      transport: async () => JSON.stringify({ route: 'r1', category: 'payments', severity_suggestion: 'SEV2', summary: 'Payments failing.' }),
    });
    const eng = new ReporterEngine(db, new FakeSlack(), llm);
    eng.loadCache();
    const t = eng.tenantForChannel('C_acme')!;
    const res = await eng.route(t, 'our payments are all failing');
    expect(res.targetChannelId).toBe('C_pay'); // r1 → first rule
    expect(res.severity).toBe('SEV2');
  });

  it('coerces an invalid model route to the default channel', async () => {
    const db = seededDb();
    const llm = new LlmClient({
      model: 'test',
      transport: async () => JSON.stringify({ route: 'C_evil', category: 'x', severity_suggestion: 'SEV3', summary: 's' }),
    });
    const eng = new ReporterEngine(db, new FakeSlack(), llm);
    eng.loadCache();
    const res = await eng.route(eng.tenantForChannel('C_acme')!, 'weird thing');
    expect(res.targetChannelId).toBe('C_triage');
  });

  it('falls back to keyword matching when the LLM is unavailable', async () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null);
    eng.loadCache();
    const login = await eng.route(eng.tenantForChannel('C_acme')!, 'we cannot login, SSO is broken');
    expect(login.targetChannelId).toBe('C_platform');
    const nomatch = await eng.route(eng.tenantForChannel('C_acme')!, 'the moon is bright today');
    expect(nomatch.targetChannelId).toBe('C_triage'); // default
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `npx vitest run test/reporter.test.ts` → FAIL (`ReporterEngine` not found).

- [ ] **Step 4: Create `src/engine/reporter.ts`** (routing portion — the rest is added in Tasks 3–4):

```ts
import {
  getTenantByChannel,
  insertRoutingRule as _insertRoutingRule, // (not used here; kept for parity)
  rulesForTenant,
  type Database,
  type Severity,
  type Tenant,
} from '../db/index.js';
import type { LlmClient } from '../llm/client.js';
import { routeTenantReport } from '../llm/prompts.js';
import type { SlackPort } from '../ports.js';
import { logger } from '../util/logger.js';

export interface RouteDecision {
  targetChannelId: string;
  category: string;
  severity: Severity;
  summary: string;
}

export interface ReporterOpts {
  /** Fallback wording when no rules/LLM produce a category. */
  defaultCategory?: string;
}

export class ReporterEngine {
  private channelToTenant = new Map<string, string>();

  constructor(
    private db: Database,
    private slack: SlackPort,
    private llm: LlmClient | null,
    private opts: ReporterOpts = {},
  ) {}

  /** Populate the channel→tenant cache from the DB (call on boot + after add/remove). */
  loadCache(): void {
    this.channelToTenant.clear();
    for (const t of this.db.prepare(`SELECT id, channel_id FROM tenants`).all() as { id: string; channel_id: string }[]) {
      this.channelToTenant.set(t.channel_id, t.id);
    }
  }

  registerTenantChannel(channelId: string, tenantId: string): void {
    this.channelToTenant.set(channelId, tenantId);
  }

  unregister(tenantId: string): void {
    for (const [chan, tid] of this.channelToTenant) if (tid === tenantId) this.channelToTenant.delete(chan);
  }

  isTenantChannel(channelId: string): boolean {
    return this.channelToTenant.has(channelId);
  }

  tenantForChannel(channelId: string): Tenant | undefined {
    const id = this.channelToTenant.get(channelId);
    return id ? (getTenantByChannel(this.db, channelId) ?? undefined) : undefined;
  }

  /** Decide the internal channel + metadata for a report. LLM first, keyword/default fallback. */
  async route(tenant: Tenant, text: string): Promise<RouteDecision> {
    const rules = rulesForTenant(this.db, tenant.id);
    const keyed = rules.map((r, i) => ({ key: `r${i + 1}`, description: r.description, channelId: r.target_channel_id }));

    if (this.llm) {
      try {
        const out = await this.llm.completeJson(
          {
            system: routeTenantReport.system,
            user: routeTenantReport.buildUser(
              text,
              tenant.name,
              tenant.tier,
              keyed.map((k) => ({ key: k.key, description: k.description })),
              tenant.extra_prompt,
            ),
            temperature: routeTenantReport.temperature,
          },
          routeTenantReport.schema,
        );
        const match = keyed.find((k) => k.key === out.route);
        return {
          targetChannelId: match?.channelId ?? tenant.default_channel_id, // untrusted route → default
          category: out.category || this.opts.defaultCategory || 'general',
          severity: out.severity_suggestion,
          summary: out.summary || text.slice(0, 140),
        };
      } catch (err) {
        logger.warn({ err, tenant: tenant.id }, 'LLM routing failed; using keyword fallback');
      }
    }
    return this.keywordRoute(tenant, keyed, text);
  }

  private keywordRoute(
    tenant: Tenant,
    keyed: { key: string; description: string; channelId: string }[],
    text: string,
  ): RouteDecision {
    const lower = text.toLowerCase();
    let best: { channelId: string; score: number } | null = null;
    for (const k of keyed) {
      const terms = k.description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const score = terms.reduce((n, term) => (lower.includes(term) ? n + 1 : n), 0);
      if (score > 0 && (!best || score > best.score)) best = { channelId: k.channelId, score };
    }
    return {
      targetChannelId: best?.channelId ?? tenant.default_channel_id,
      category: this.opts.defaultCategory ?? 'general',
      severity: 'SEV3',
      summary: text.slice(0, 140),
    };
  }
}
```

> Note: delete the unused `insertRoutingRule as _insertRoutingRule` import line — it is a copy-paste guard reminder, not needed. Keep imports to exactly what the file uses so `tsc` stays clean.

- [ ] **Step 5: Run test to verify it passes** — `npx vitest run test/reporter.test.ts` → PASS (7 tests total). `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/llm/prompts.ts src/engine/reporter.ts test/reporter.test.ts
git commit -m "feat: tenant report routing (P9 + ReporterEngine.route with fallback)"
```

---

### Task 3: Report intake lifecycle + triage card

**Files:**
- Create: `src/slack/blocks/tenantReport.ts`
- Modify: `src/engine/reporter.ts` (add `handleReport`)
- Modify: `src/slack/actions.ts` (extend `PreIncidentRecord` with optional `tenantReportId`)
- Test: `test/reporter.test.ts` (lifecycle section)

**Interfaces:**
- Consumes: `RouteDecision`, `nextTenantReportId`, `insertTenantReport`, `setConfigValue`, `dateStamp`, `now`, `SlackPort.postMessage`.
- Produces:
  - `tenantReportTriageBlocks(report: TenantReport, tenant: Tenant, summary: string): Block[]` with `[🚨 Declare incident] [✋ Decline]` buttons whose `value` is the report id.
  - `ReporterEngine.handleReport(opts: { tenant: Tenant; reporterUserId: string; text: string; threadTs: string }): Promise<TenantReport>` — routes, inserts the report (status `routed`), writes a `preincident:<TR-id>` record (with `tenantReportId`), posts the triage card to the routed channel, and posts a customer-safe ack in the source thread.
  - Extended `PreIncidentRecord` in `actions.ts`: add `tenantReportId?: string`.

- [ ] **Step 1: Create `src/slack/blocks/tenantReport.ts`**

```ts
import type { Tenant, TenantReport } from '../../db/index.js';
import type { Block } from './warroom.js';

export function tenantReportTriageBlocks(report: TenantReport, tenant: Tenant, summary: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📨 *Customer report* — *${tenant.name}*${tenant.tier ? ` _(${tenant.tier})_` : ''} · ref \`${report.id}\`\n${summary}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Reported by <@${report.reporter_user_id}> · suggested *${report.severity_suggestion}* · category \`${report.category}\``,
        },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `> ${report.report_text.replace(/\n/g, '\n> ')}` } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'declare_incident',
          style: 'danger',
          text: { type: 'plain_text', text: '🚨 Declare incident', emoji: true },
          value: report.id,
        },
        {
          type: 'button',
          action_id: 'decline_report',
          text: { type: 'plain_text', text: '✋ Decline', emoji: true },
          value: report.id,
        },
      ],
    },
  ];
}
```

- [ ] **Step 2: Write the failing test** (append):

```ts
import { getTenantReport as _get } from '../src/db/index.js'; // if not already imported, reuse existing import

describe('ReporterEngine.handleReport', () => {
  it('routes, records the report, posts one triage card, and acks the customer safely', async () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null); // keyword fallback path
    eng.loadCache();
    const slack = (eng as unknown as { slack: FakeSlack }).slack;
    const t = eng.tenantForChannel('C_acme')!;

    const report = await eng.handleReport({ tenant: t, reporterUserId: 'UEXT', text: 'payments are failing for our users', threadTs: '10.1' });

    expect(report.id).toMatch(/^TR-\d{8}-001$/);
    expect(report.routed_channel_id).toBe('C_pay');
    expect(report.status).toBe('routed');

    // Exactly one triage card to the internal channel, and one ack in the tenant thread.
    const card = slack.posted.find((p) => p.channel === 'C_pay');
    expect(card).toBeDefined();
    const ack = slack.posted.find((p) => p.channel === 'C_acme');
    expect(ack).toBeDefined();
    expect(ack!.thread_ts).toBe('10.1');

    // Customer-safe: ack must not leak internal channel ids or war-room/cost terms.
    expect(ack!.text).not.toMatch(/C_pay|C_triage|war room|\$/i);
    expect(ack!.text).toContain(report.id);

    // A preincident record exists so the existing declare button works.
    const raw = db.prepare(`SELECT value FROM config WHERE key = ?`).get(`preincident:${report.id}`) as { value: string };
    const pre = JSON.parse(raw.value);
    expect(pre.tenantReportId).toBe(report.id);
    expect(pre.sourceChannelId).toBe('C_pay'); // internal channel — war-room notice goes here, not to the customer
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `npx vitest run test/reporter.test.ts` → FAIL (`handleReport` not a function).

- [ ] **Step 4: Add `handleReport` to `src/engine/reporter.ts`** (imports: add `nextTenantReportId`, `insertTenantReport`, `setConfigValue`, `type TenantReport` from db; `dateStamp`, `now` from `../util/time.js`; `tenantReportTriageBlocks` from `../slack/blocks/tenantReport.js`):

```ts
  async handleReport(opts: {
    tenant: Tenant;
    reporterUserId: string;
    text: string;
    threadTs: string;
  }): Promise<TenantReport> {
    const decision = await this.route(opts.tenant, opts.text);
    const id = nextTenantReportId(this.db, dateStamp(now()));
    const report: TenantReport = {
      id,
      tenant_id: opts.tenant.id,
      reporter_user_id: opts.reporterUserId,
      report_text: opts.text,
      source_channel_id: opts.tenant.channel_id,
      source_thread_ts: opts.threadTs,
      routed_channel_id: decision.targetChannelId,
      category: decision.category,
      severity_suggestion: decision.severity,
      status: 'routed',
      incident_id: null,
      created_at: now(),
    };
    insertTenantReport(this.db, report);

    // Reuse the existing declare flow: a preincident record keyed by the report id.
    // sourceChannelId is the INTERNAL routed channel (safe for the war-room link);
    // the customer loop-back is handled separately via tenantReportId.
    setConfigValue(
      this.db,
      `preincident:${id}`,
      JSON.stringify({
        title: decision.summary,
        service: decision.category,
        severity: decision.severity,
        signalIds: [],
        sourceChannelId: decision.targetChannelId,
        tenantReportId: id,
      }),
    );

    await this.slack.postMessage({
      channel: decision.targetChannelId,
      text: `📨 Customer report from ${opts.tenant.name} (${id})`,
      blocks: tenantReportTriageBlocks(report, opts.tenant, decision.summary),
    });

    // Customer-safe acknowledgement in the tenant's thread (no internal names/links).
    await this.slack.postMessage({
      channel: opts.tenant.channel_id,
      thread_ts: opts.threadTs,
      text: `👋 Thanks — we've logged this (ref \`${id}\`) and our team is reviewing it. We'll post updates right here.`,
    });

    return report;
  }
```

- [ ] **Step 5: Extend `PreIncidentRecord` in `src/slack/actions.ts`** — add the optional field (interface near the top of the file):

```ts
interface PreIncidentRecord {
  title: string;
  service: string;
  severity: Severity;
  signalIds: number[];
  sourceChannelId: string;
  tenantReportId?: string;
}
```

- [ ] **Step 6: Run test to verify it passes** — `npx vitest run test/reporter.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/engine/reporter.ts src/slack/blocks/tenantReport.ts src/slack/actions.ts test/reporter.test.ts
git commit -m "feat: tenant report intake — triage card + customer-safe ack"
```

---

### Task 4: Declare/resolve loop-back to the customer thread

**Files:**
- Modify: `src/engine/reporter.ts` (add `onIncidentDeclaredFromReport`, `onIncidentResolved`)
- Test: `test/reporter.test.ts` (loop-back section)

**Interfaces:**
- Consumes: `getTenantReport`, `updateTenantReport`, `tenantReportsForIncident`, `Incident` type, `SlackPort.postMessage`.
- Produces:
  - `ReporterEngine.onIncidentDeclaredFromReport(reportId: string, incidentId: string): Promise<void>` — marks the report `linked_incident` + stores `incident_id`, posts a customer-safe "incident opened" note in the report's source thread.
  - `ReporterEngine.onIncidentResolved(incidentId: string): Promise<void>` — for each linked report, posts a customer-safe "resolved" note in its source thread.

- [ ] **Step 1: Write the failing test** (append):

```ts
describe('ReporterEngine loop-back (customer-safe)', () => {
  it('notifies the customer thread on declare and on resolve without leaking internals', async () => {
    const db = seededDb();
    const eng = new ReporterEngine(db, new FakeSlack(), null);
    eng.loadCache();
    const slack = (eng as unknown as { slack: FakeSlack }).slack;
    const t = eng.tenantForChannel('C_acme')!;
    const report = await eng.handleReport({ tenant: t, reporterUserId: 'UEXT', text: 'login is down', threadTs: '11.0' });

    await eng.onIncidentDeclaredFromReport(report.id, 'INC-20260708-001');
    const updated = getTenantReport(db, report.id)!;
    expect(updated.status).toBe('linked_incident');
    expect(updated.incident_id).toBe('INC-20260708-001');

    const declMsg = slack.posted.filter((p) => p.channel === 'C_acme' && p.thread_ts === '11.0').at(-1)!;
    expect(declMsg.text).toContain(report.id);
    expect(declMsg.text).not.toMatch(/C_platform|C_triage|INC-2026|war room|\$/i); // no internal incident id/channel/cost

    await eng.onIncidentResolved('INC-20260708-001');
    const resMsg = slack.posted.filter((p) => p.channel === 'C_acme' && p.thread_ts === '11.0').at(-1)!;
    expect(resMsg.text).toMatch(/resolved/i);
    expect(resMsg.text).not.toMatch(/C_platform|C_triage|INC-2026|\$/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run test/reporter.test.ts` → FAIL (`onIncidentDeclaredFromReport` not a function).

- [ ] **Step 3: Add the loop-back methods to `src/engine/reporter.ts`** (imports: add `getTenantReport`, `updateTenantReport`, `tenantReportsForIncident`):

```ts
  async onIncidentDeclaredFromReport(reportId: string, incidentId: string): Promise<void> {
    const report = getTenantReport(this.db, reportId);
    if (!report) return;
    updateTenantReport(this.db, reportId, { status: 'linked_incident', incident_id: incidentId });
    await this.slack.postMessage({
      channel: report.source_channel_id,
      thread_ts: report.source_thread_ts,
      text: `🛠️ We've opened an incident for the issue you reported (ref \`${reportId}\`). Our team is actively working on it and we'll update you here.`,
    });
  }

  async onIncidentResolved(incidentId: string): Promise<void> {
    for (const report of tenantReportsForIncident(this.db, incidentId)) {
      if (report.status !== 'linked_incident') continue;
      await this.slack.postMessage({
        channel: report.source_channel_id,
        thread_ts: report.source_thread_ts,
        text: `✅ The issue you reported (ref \`${report.id}\`) has been resolved. Thanks for flagging it — please let us know if you still see any trouble.`,
      });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run test/reporter.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/reporter.ts test/reporter.test.ts
git commit -m "feat: customer-safe declare/resolve loop-back for tenant reports"
```

---

### Task 5: Slack surface wiring (commands, app_mention, actions, bootstrap)

**Files:**
- Modify: `src/context.ts` (add `reporter`)
- Modify: `src/slack/commands.ts` (`/incident tenant …`)
- Modify: `src/slack/events.ts` (`app_mention` branch)
- Modify: `src/slack/actions.ts` (declare loop-back + `decline_report`)
- Modify: `src/index.ts` (construct + cache + `onResolved` wiring)
- Test: `test/reporter.test.ts` (command-parse guard) — Slack handlers themselves are thin and covered by the engine tests.

**Interfaces:**
- Consumes: everything from Tasks 1–4; existing `withBoundary`, `getConfigValue`, `IncidentCore`, `core.onResolved`.
- Produces:
  - `AppContext.reporter: ReporterEngine`.
  - Exported helper `parseChannelArg(raw: string): string | { name: string }` in `commands.ts` — returns a channel id from `<#C123|name>` / raw id, or `{name}` to resolve by name. (Testable without Slack.)
  - New action `decline_report`.

- [ ] **Step 1: Add `reporter` to `src/context.ts`**

```ts
import type { ReporterEngine } from './engine/reporter.js';
// ...inside AppContext:
  reporter: ReporterEngine;
```

- [ ] **Step 2: Write the failing test for the parse helper** (append):

```ts
import { parseChannelArg } from '../src/slack/commands.js';

describe('parseChannelArg', () => {
  it('extracts a channel id from a Slack mention', () => {
    expect(parseChannelArg('<#C123|payments>')).toBe('C123');
    expect(parseChannelArg('<#C456>')).toBe('C456');
  });
  it('returns a name marker for a plain #name', () => {
    expect(parseChannelArg('#payments-team')).toEqual({ name: 'payments-team' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `npx vitest run test/reporter.test.ts` → FAIL (`parseChannelArg` not exported).

- [ ] **Step 4: Add the `tenant` subcommand + helper to `src/slack/commands.ts`**

Add the export near the bottom:

```ts
/** Parse a channel arg: `<#C123|name>` / `<#C123>` → id; `#name` / `name` → {name} to resolve. */
export function parseChannelArg(raw: string): string | { name: string } {
  const mention = raw.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/i);
  if (mention) return mention[1];
  const clean = raw.replace(/^#/, '');
  if (/^C[A-Z0-9]{6,}$/i.test(clean)) return clean;
  return { name: clean };
}
```

Add a `case 'tenant':` in the `/incident` switch (alongside `declare`, `status`, etc.). It refuses to run from a registered tenant channel and dispatches the subcommands:

```ts
        case 'tenant': {
          if (ctx.reporter.isTenantChannel(command.channel_id)) {
            await respond({ response_type: 'ephemeral', text: 'Run tenant admin commands from an internal channel, not a customer channel.' });
            return;
          }
          await handleTenant(ctx, rest, respond);
          return;
        }
```

And the handler (new function in the same file). Resolve channel args via `parseChannelArg` + `ctx.slack.channelIdByName`:

```ts
async function resolveChannel(ctx: AppContext, raw: string): Promise<string | undefined> {
  const parsed = parseChannelArg(raw);
  return typeof parsed === 'string' ? parsed : ctx.slack.channelIdByName(parsed.name);
}

async function handleTenant(ctx: AppContext, rest: string[], respond: Respond): Promise<void> {
  const [action, ...args] = rest;
  const nowS = Math.floor(Date.now() / 1000);

  if (action === 'add' && args.length >= 2) {
    const [slug, chanArg, ...flags] = args;
    const channelId = await resolveChannel(ctx, chanArg);
    if (!channelId) { await respond({ response_type: 'ephemeral', text: `Couldn't resolve channel ${chanArg}.` }); return; }
    const tierIdx = flags.indexOf('--tier');
    const defIdx = flags.indexOf('--default');
    const tier = tierIdx >= 0 ? flags[tierIdx + 1] : null;
    const defaultChannelId = defIdx >= 0 ? (await resolveChannel(ctx, flags[defIdx + 1])) ?? channelId : channelId;
    insertTenant(ctx.db, {
      id: slug, name: slug.toUpperCase(), channel_id: channelId, slack_team_id: null,
      tier, default_channel_id: defaultChannelId, extra_prompt: null, created_at: nowS,
    });
    await ctx.slack.joinChannel(channelId);
    ctx.reporter.registerTenantChannel(channelId, slug);
    await respond({ response_type: 'ephemeral', text: `✅ Registered tenant \`${slug}\` on <#${channelId}> (default route <#${defaultChannelId}>).` });
    return;
  }

  if (action === 'rule' && args.length >= 3) {
    const [slug, chanArg, ...descParts] = args;
    if (!getTenant(ctx.db, slug)) { await respond({ response_type: 'ephemeral', text: `Unknown tenant \`${slug}\`.` }); return; }
    const target = await resolveChannel(ctx, chanArg);
    if (!target) { await respond({ response_type: 'ephemeral', text: `Couldn't resolve channel ${chanArg}.` }); return; }
    insertRoutingRule(ctx.db, { tenant_id: slug, target_channel_id: target, description: descParts.join(' '), created_at: nowS });
    await respond({ response_type: 'ephemeral', text: `✅ Rule added for \`${slug}\` → <#${target}>: _${descParts.join(' ')}_` });
    return;
  }

  if (action === 'prompt' && args.length >= 2) {
    const [slug, ...promptParts] = args;
    const t = getTenant(ctx.db, slug);
    if (!t) { await respond({ response_type: 'ephemeral', text: `Unknown tenant \`${slug}\`.` }); return; }
    insertTenant(ctx.db, { ...t, extra_prompt: promptParts.join(' ') });
    await respond({ response_type: 'ephemeral', text: `✅ Guidance updated for \`${slug}\`.` });
    return;
  }

  if (action === 'list') {
    const tenants = listTenants(ctx.db);
    const lines = tenants.map((t) => {
      const rules = rulesForTenant(ctx.db, t.id).map((r) => `   • <#${r.target_channel_id}>: ${r.description}`).join('\n');
      return `*${t.id}* (${t.tier ?? 'standard'}) on <#${t.channel_id}> → default <#${t.default_channel_id}>\n${rules || '   • (no rules)'}`;
    });
    await respond({ response_type: 'ephemeral', text: lines.join('\n\n') || 'No tenants registered.' });
    return;
  }

  if (action === 'remove' && args.length >= 1) {
    removeTenant(ctx.db, args[0]);
    ctx.reporter.unregister(args[0]);
    await respond({ response_type: 'ephemeral', text: `🗑️ Removed tenant \`${args[0]}\`.` });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: 'Usage: `/incident tenant add <slug> <#channel> [--tier t] [--default #chan]` · `rule <slug> <#channel> <desc>` · `prompt <slug> <text>` · `list` · `remove <slug>`',
  });
}
```

Add imports at the top of `commands.ts`: `insertTenant, insertRoutingRule, getTenant, listTenants, rulesForTenant, removeTenant` from `../db/index.js`, and `type AppContext` already present.

- [ ] **Step 5: Branch `app_mention` in `src/slack/events.ts`** — at the top of the handler, before the assistant Q&A path:

```ts
  app.event(
    'app_mention',
    withBoundary('event:app_mention', async ({ event }) => {
      const e = event as unknown as { channel: string; text: string; ts: string; thread_ts?: string; user?: string };
      // Tenant report path: a customer @mention in a registered Slack Connect channel.
      const tenant = ctx.reporter.tenantForChannel(e.channel);
      if (tenant && e.user && e.user !== ctx.botUserId) {
        const reportText = e.text.replace(/<@[^>]+>/g, '').trim();
        if (!reportText) return;
        await ctx.reporter.handleReport({
          tenant,
          reporterUserId: e.user,
          text: reportText,
          threadTs: e.thread_ts ?? e.ts,
        });
        return;
      }
      // Otherwise: internal assistant Q&A (unchanged).
      const question = e.text.replace(/<@[^>]+>/g, '').trim();
      if (!question) return;
      const answer = await answerIncidentQuestion(
        { db: ctx.db, llm: ctx.llm, memory: ctx.memory, rts: ctx.rts, channels: [...ctx.watchChannelIds] },
        question,
      );
      await ctx.slack.postMessage({ channel: e.channel, text: answer, thread_ts: e.thread_ts ?? e.ts });
    }),
  );
```

- [ ] **Step 6: Loop-back on declare + `decline_report` in `src/slack/actions.ts`** — in the existing `declare_incident` handler, after the war-room-created post, add:

```ts
      if (pre.tenantReportId && inc) {
        await ctx.reporter.onIncidentDeclaredFromReport(pre.tenantReportId, inc.id);
      }
```

Register the new action (near the other triage actions):

```ts
  app.action(
    'decline_report',
    withBoundary('action:decline_report', async ({ ack, body, action }) => {
      await ack();
      const reportId = buttonValue(action);
      const report = getTenantReport(ctx.db, reportId);
      if (!report) return;
      updateTenantReport(ctx.db, reportId, { status: 'declined' });
      const who = (body as { user: { id: string } }).user.id;
      const channel = (body as { channel?: { id: string } }).channel?.id;
      if (channel) await ctx.slack.postMessage({ channel, text: `✋ <@${who}> marked ${reportId} as not an incident.` });
      // Customer-safe close-out in the tenant thread.
      await ctx.slack.postMessage({
        channel: report.source_channel_id,
        thread_ts: report.source_thread_ts,
        text: `Thanks for the report (ref \`${reportId}\`). We looked into it and it doesn't appear to be a service incident — our team will follow up if anything changes.`,
      });
    }),
  );
```

Add imports to `actions.ts`: `getTenantReport, updateTenantReport` from `../db/index.js`.

- [ ] **Step 7: Construct + wire in `src/index.ts`** — after the other engines are built:

```ts
import { ReporterEngine } from './engine/reporter.js';
// ...
  const reporter = new ReporterEngine(db, slack, llm);
  reporter.loadCache();
```

Add `reporter` to the `ctx` object literal. In the existing `core.onResolved(async (incident) => { ... })` hook, add:

```ts
    await reporter.onIncidentResolved(incident.id).catch((err) => logger.warn({ err }, 'reporter resolve loop-back failed'));
```

- [ ] **Step 8: Run the full suite + typecheck + build**

Run: `npx vitest run` → Expected: all prior tests + new reporter tests PASS.
Run: `npx tsc --noEmit` → clean.
Run: `npm run build` → succeeds.

- [ ] **Step 9: Boot smoke test** (no tokens needed — expect the clean credentials error, proving nothing threw during wiring):

Run: `npx tsx src/index.ts`
Expected: logs `Missing Slack credentials…` and exits 1 (same as before — confirms ReporterEngine construction + cache load don't crash boot).

- [ ] **Step 10: Commit**

```bash
git add src/context.ts src/slack/commands.ts src/slack/events.ts src/slack/actions.ts src/index.ts test/reporter.test.ts
git commit -m "feat: wire tenant reporter into commands, app_mention, declare/decline, bootstrap"
```

---

### Task 6: README + manifest touch-ups

**Files:**
- Modify: `sentinel-ic/README.md` (new "Customer incident reporting" section + commands)
- Modify: `sentinel-ic/manifest.json` (confirm scopes; note Slack Connect)

**Interfaces:** none (docs only).

- [ ] **Step 1: Confirm manifest scopes** — the bot already has `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `channels:join`. These cover receiving external @mentions and posting in a shared channel. No manifest change is required; add a comment in the README that the app must be **added to** each Slack Connect channel (the customer need not install the app). If `conversations.info`-based team-id capture is added later it needs no extra scope beyond `channels:read`.

- [ ] **Step 2: Add a README section** under the features list:

```markdown
## 📨 Customer incident reporting (multi-tenant)

Give your customers a direct line without a helpdesk. Share one Slack Connect channel per customer, add Sentinel to it, and register the tenant:

    /incident tenant add acme #acme-yourco --tier enterprise --default #support-triage
    /incident tenant rule acme #payments-team  payments, billing, refunds, invoices
    /incident tenant rule acme #platform-team   login, SSO, access, authentication
    /incident tenant prompt acme  Acme is enterprise; treat checkout errors as urgent
    /incident tenant list

When someone at Acme **@mentions the bot** in their channel, Sentinel classifies the report against Acme's rules, posts a triage card to the right internal team (`[Declare incident] [Decline]`), and acknowledges the customer in-thread. Declaring builds the usual war room; on declare and on resolve, the customer's thread gets a customer-safe update. Reports never leak internal channel names, war-room links, or cost figures back to the customer.

Admin `/incident tenant …` commands run from your internal channels only. External customers use @mention (Slack Connect doesn't deliver slash commands/buttons to external users).
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document customer incident reporting (multi-tenant)"
```

---

## Self-Review Notes

- **Spec coverage:** tenant registry + NL rules (Task 1 DB, Task 5 commands); @mention-only intake (Task 5 events); tenant resolution + cache (Task 2); LLM router P9 + fallback + invalid-route coercion (Task 2); triage card in mapped channel reusing declare (Task 3); customer-safe ack (Task 3); declare/resolve loop-back (Tasks 4–5); data model 3 tables (Task 1); non-goals (correlation/SLA) not built. All covered.
- **Type consistency:** `RouteDecision.targetChannelId/severity/category/summary`, `ReporterEngine` method names, and `PreIncidentRecord.tenantReportId` are used identically across tasks. `TenantReport` fields match the schema columns exactly.
- **Constraints honored:** admin commands guarded against tenant channels (Task 5 step 4); customer-safe assertions are explicit test cases (Tasks 3–4); model route coerced to default (Task 2); event-driven cache, no history polling.
- **Cannot verify against a live Slack workspace here** (no tokens): verification = full vitest suite + `tsc` + build + boot smoke test, matching how the base project is verified.
