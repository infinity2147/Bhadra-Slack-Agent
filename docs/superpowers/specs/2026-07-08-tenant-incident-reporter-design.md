# Tenant Incident Reporter — Design

**Date:** 2026-07-08
**Status:** Approved for planning
**Feature area:** Sentinel IC — customer-facing intake + routing

## Problem & positioning

Sentinel IC today detects incidents from *internal* engineer chatter. But in B2B SaaS, customers are frequently the **first** to notice a problem ("checkout is failing for our users"), and today those reports hit a manual support buffer (L1→L2→L3) before anyone recognizes a systemic issue and declares an incident. Market research (Pylon, Thena, Unthread, Zendesk-for-Slack on the intake side; PagerDuty, incident.io, Rootly on the incident side) confirms two facts:

1. The dominant pattern is **one Slack Connect channel per customer company**, with tooling that classifies each message and **routes it to the right internal team**.
2. The valuable, under-served seam is **turning a customer report into a correctly-routed, declarable incident** — customers as an early-warning signal source.

**Positioning:** Sentinel remains an *incident* tool. Customer reports become a **new signal source into the existing detect → triage → declare pipeline** — not a full helpdesk. Tagline: *"Sentinel reads the room — now including your customers' room."*

## Actors & terminology

- **Vendor** — the company running Sentinel IC (a B2B SaaS company).
- **Tenant** — one of the vendor's customer companies, connected via a **Slack Connect channel** (one channel per tenant, e.g. `#acme-yourco`). The vendor grants access by sharing the channel and adding the bot; the tenant does **not** install the app.
- **Internal team channels** — the vendor's own channels (`#payments-team`, `#platform-team`, `#support-triage`) that reports route to.

## Scope (v1)

**In scope:** tenant registry + natural-language routing rules; `@mention`-only report intake in registered Slack Connect channels; tenant resolution; LLM router → triage card in the mapped internal team channel; customer-safe acknowledgement; declare/resolve loop-back to the customer's thread.

**Out of scope (explicit non-goals):** cross-tenant correlation ("3 customers reporting X" — deferred to v2); SLA timers / business-hours; CSAT; a ticket inbox UI; auto-detecting plain (un-mentioned) messages; the customer using slash commands or buttons (Slack Connect does not deliver those to external users).

## Hard constraints (from Slack Connect research)

1. **External users cannot use slash commands or interactive buttons** across Slack Connect. The customer trigger is therefore **`app_mention` only**. Admin config commands run in the vendor's *internal* channels, where slash commands work normally.
2. The bot must be **added to the shared channel**; the tenant need not install the app.
3. **Data minimization:** acknowledgements and loop-back messages posted into a tenant channel must be **customer-safe** — never leak internal channel names, other tenants, war-room links, cost figures, or internal user IDs.
4. **Event-driven only** — no `conversations.history` polling (non-Marketplace rate limits). Tenant identity is resolved from the event/channel and **cached**.

## Data model (additions to `src/db/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,              -- slug, e.g. 'acme'
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,         -- the Slack Connect channel id
  slack_team_id TEXT,               -- external team id, when known (resolution aid)
  tier TEXT,                        -- e.g. 'enterprise' | 'standard' (optional)
  default_channel_id TEXT NOT NULL, -- fallback route when no rule matches
  extra_prompt TEXT,                -- admin free-text guidance fed to the router
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_routing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  target_channel_id TEXT NOT NULL,  -- internal team channel to route to
  description TEXT NOT NULL,         -- natural-language rule, e.g. "payments, billing, refunds"
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_reports (
  id TEXT PRIMARY KEY,              -- TR-YYYYMMDD-XXX
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reporter_user_id TEXT,            -- external user id (foreign namespace)
  report_text TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,  -- the tenant channel
  source_thread_ts TEXT NOT NULL,   -- thread to post ack + loop-back into
  routed_channel_id TEXT,           -- internal channel it was routed to
  category TEXT,
  severity_suggestion TEXT,
  status TEXT NOT NULL,             -- routed | declined | linked_incident
  incident_id TEXT,                 -- set when a team declares from this report
  created_at INTEGER NOT NULL
);
```

Channel→tenant resolution is cached in-process (`Map<channelId, tenantId>`), populated from the `tenants` table on boot and on tenant add.

## Components

### 1. Tenant registry & config commands (`src/slack/commands.ts` extension)
New `/incident tenant …` subcommands (run from internal channels only; refuse if invoked from a registered tenant channel):
```
/incident tenant add <slug> <#channel> [--tier <t>] [--default <#channel>]
/incident tenant rule <slug> <#channel> <natural-language description>
/incident tenant prompt <slug> <free text>
/incident tenant list
/incident tenant remove <slug>
```
`#channel` args accept `<#C123|name>` mentions or raw ids. `add` resolves and caches the channel→tenant mapping and best-effort joins/records the external team id via `conversations.info`.

### 2. Reporter engine (`src/engine/reporter.ts`)
```
class ReporterEngine {
  isTenantChannel(channelId): boolean
  tenantForChannel(channelId): Tenant | undefined
  handleReport(opts: {tenantId, reporterUserId, text, channelId, threadTs}): Promise<TenantReport>
  // routes via LLM (P9) → posts triage card to routed channel → acks customer
  onIncidentDeclaredFromReport(reportId, incident): Promise<void>  // customer-safe thread update
  onIncidentResolved(incident): Promise<void>                       // notifies linked tenant threads
}
```
Routing: build the router prompt from the tenant's rules + `extra_prompt`; P9 returns `{route_channel_key, category, severity_suggestion, summary}`. `route_channel_key` must be one of the tenant's rule targets or `default`; the engine maps it to a channel id (never trusts a raw id from the model). Fallback when LLM is unavailable: keyword-match the report text against each rule's `description`; no match → default channel.

### 3. LLM router prompt (`src/llm/prompts.ts` — P9 `routeTenantReport`)
Inputs: report text, tenant name/tier, the ordered list of `{key, description}` rules, and `extra_prompt`. Output (strict JSON, zod-validated): `{ route: string, category: string, severity_suggestion: 'SEV1'|'SEV2'|'SEV3'|'SEV4', summary: string }` where `route` ∈ rule keys ∪ `{"default"}`. Temperature 0.2. System prompt states the vendor/tenant framing and that severity is only a *suggestion* a human confirms.

### 4. Triage card (`src/slack/blocks/tenantReport.ts`)
Posted into the routed internal channel: tenant name + tier, reporter (as external), verbatim report, LLM summary, suggested severity/category, and buttons `[🚨 Declare incident] [✋ Decline]`. Reuses the existing `preincident:<key>` record + `declare_incident` action by writing a `PreIncidentRecord` whose `sourceChannelId` is the **internal** channel and adding an optional `tenantReportId` field so the declare handler can trigger the customer loop-back.

### 5. Wiring
- `src/slack/events.ts` `app_mention`: if the mention is in a registered tenant channel → `ReporterEngine.handleReport`; otherwise the existing assistant Q&A path (unchanged).
- `src/slack/actions.ts` `declare_incident`: when the loaded `PreIncidentRecord` has a `tenantReportId`, after declaring, call `ReporterEngine.onIncidentDeclaredFromReport` (customer-safe ack in the tenant thread) and set `tenant_reports.status='linked_incident'`, `incident_id`. New `decline_report` action marks the report declined and posts a courteous customer-safe note.
- `src/index.ts` `core.onResolved`: also call `ReporterEngine.onIncidentResolved` so any linked tenant threads get a resolved note.

## Data flow

```
Customer @mentions bot in #acme-yourco
   → events.ts detects registered tenant channel
   → ReporterEngine.handleReport
        → P9 router (rules + prompt)  ─fallback→ keyword match / default
        → insert tenant_reports (status=routed)
        → post triage card to routed internal channel  (preincident record incl. tenantReportId)
        → ack customer in-thread (customer-safe)
   … internal team clicks [Declare]
        → existing declare flow builds the war room
        → onIncidentDeclaredFromReport → customer thread: "an incident has been opened, we're on it"
   … incident resolves
        → onIncidentResolved → customer thread: "resolved" (customer-safe)
```

## Error handling & degradation
- LLM router failure → keyword/default routing (never drops a report).
- `conversations.info` failure on tenant add → still register by channel id; team id left null.
- All handlers stay inside `withBoundary`; a routing failure posts a fallback triage card to the tenant's default channel rather than silently dropping.
- Unknown/unregistered channel mention → falls through to normal assistant Q&A (no behavior change).

## Testing (`test/reporter.test.ts`, plus prompt/DB units)
- Router: rule match routes to the right channel; ambiguous → default; LLM-off keyword fallback; model returning an invalid `route` is coerced to default (never an arbitrary channel).
- Tenant registry: channel→tenant resolution + cache; config commands refuse to run from a tenant channel.
- Report lifecycle: `handleReport` inserts a `tenant_reports` row and posts exactly one triage card + one customer ack; declare loop-back sets `status=linked_incident` and posts a customer-safe (no internal names/links) thread update; resolve notifies the linked thread.
- Customer-safe assertion: ack/loop-back text contains no internal channel id, war-room link, or cost figure.

## Future (v2, out of this spec)
Cross-tenant correlation (cluster similar reports across tenants → suggest one incident, link all threads); SLA/business-hours; optional customer-side app install to unlock buttons/slash commands.
