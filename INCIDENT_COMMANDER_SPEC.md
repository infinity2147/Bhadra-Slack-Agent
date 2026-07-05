# Sentinel IC — Slack-Native AI Incident Commander
## Complete Product Specification & Build Instructions for Claude Code

> **Purpose of this document:** This is an end-to-end build specification. Claude Code should treat this as the single source of truth to scaffold, implement, test, and package a production-quality Slack agent for the Slack Agent Builder Challenge (Devpost, deadline July 14, 2026). Build incrementally in the phase order given in §10. Do not skip the demo/seed tooling in §11 — the hackathon demo depends on it.

---

## 1. Product Overview

**Name:** Sentinel IC (working name; configurable via env)

**One-liner:** A Slack-native AI incident commander that detects trouble from human chatter before pagers fire, autonomously runs the war room, recalls how similar past incidents were fixed, and writes the postmortem — all inside Slack.

**Hackathon track:** New Slack Agent (primary). Uses all three qualifying technologies:
1. **Slack AI capabilities** (Agent/Assistant surface, App Home, AI-generated messages)
2. **MCP server integration** (GitHub, Datadog/Sentry-style observability, PagerDuty-style paging — with mock MCP servers for demo)
3. **Real-Time Search (RTS) API** (early-warning signal detection + historical incident similarity recall)

**The problem:** The first 10 minutes of any incident are chaos: someone notices, someone asks "is it just me?", someone eventually creates a channel, hunts for the runbook, pings the wrong on-call, and stakeholders get silence. Existing tools (PagerDuty, Rootly, FireHydrant, incident.io) are external platforms that *integrate into* Slack; they react to alerts, they don't read the room, and they don't reason over historical incident conversations.

**The differentiators (in priority order):**
1. **Pre-incident detection ("reads the room"):** Uses RTS over designated channels to detect clusters of trouble-signals in human messages ("checkout is slow for anyone else?", "seeing 500s") correlated with recent deploy events → opens a pre-incident triage thread *before* monitoring alerts fire.
2. **Institutional memory:** On incident open, RTS + vector similarity over past incident records → "This looks 83% similar to INC-042 (Redis connection pool exhaustion, Mar 12). Resolved by restarting pool + raising max_connections. Resolver @sam is online."
3. **Autonomous war-room operations:** Auto-creates channel, assigns roles, pins timeline, pulls runbooks/deploy diffs via MCP, timed stakeholder updates.
4. **Blameless postmortem interviewer:** After resolution, DMs each participant 2–3 tailored questions, synthesizes interviews + timeline into a postmortem doc.
5. **Stakeholder translation layer:** One incident, three auto-drafted narratives (engineering-technical, executive summary, customer-facing status copy).
6. **Live cost meter:** Estimated $/min impact ticking in the war-room bookmark/header (configured per-service revenue rates).
7. **Chaos drill mode:** Simulated incidents to train teams and to safely record the demo video.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                            SLACK WORKSPACE                          │
│  #deploys  #eng-general  #alerts   #inc-2026-07-06-checkout  DMs   │
└───────▲───────────▲──────────▲──────────────▲──────────────▲──────┘
        │  Events API / Socket Mode / RTS API / Web API              
┌───────┴───────────┴──────────┴──────────────┴──────────────┴──────┐
│                        SENTINEL IC SERVICE (Node.js + Bolt)        │
│                                                                    │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────┐  │
│  │ Signal Engine │  │ Incident Core │  │ Postmortem Engine      │  │
│  │ (RTS poller + │  │ (state machine│  │ (interviewer + doc     │  │
│  │  event stream │  │  + war room   │  │  synthesizer)          │  │
│  │  classifier)  │  │  orchestrator)│  │                        │  │
│  └──────┬───────┘  └──────┬────────┘  └──────────┬─────────────┘  │
│         │                 │                      │                 │
│  ┌──────┴─────────────────┴──────────────────────┴─────────────┐  │
│  │             LLM Layer (Anthropic API, Claude)                │  │
│  │  classify signals · draft comms · similarity summarize ·     │  │
│  │  interview · synthesize postmortem · translate narratives    │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│  ┌───────────────┐  ┌───────┴────────┐  ┌────────────────────┐    │
│  │ MCP Client Hub │  │ Memory Store   │  │ Scheduler          │    │
│  │ github · obs · │  │ SQLite + vector│  │ (update cadence,   │    │
│  │ paging · docs  │  │ embeddings     │  │ cost meter ticks)  │    │
│  └───────────────┘  └────────────────┘  └────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
        │                        │
┌───────┴────────┐      ┌────────┴─────────┐
│ Mock MCP Servers│      │ SQLite (file DB) │
│ (demo: deploys, │      │ incidents, msgs, │
│ metrics, oncall)│      │ embeddings, cfg  │
└────────────────┘      └──────────────────┘
```

**Runtime:** Node.js 20+, TypeScript, Slack Bolt for JS (Socket Mode for dev/demo; HTTP mode behind env flag for production). SQLite via better-sqlite3 (zero-ops, hackathon-appropriate). Anthropic SDK for LLM calls. MCP TypeScript SDK for MCP client + mock servers.

**Why Socket Mode:** no public URL needed for the judged sandbox; flip `SLACK_MODE=http` + request URL for Marketplace path later.

---

## 3. Repository Layout

```
sentinel-ic/
├── README.md                     # setup, demo script, architecture
├── .env.example
├── package.json
├── tsconfig.json
├── manifest.json                 # Slack app manifest (source of truth for scopes)
├── src/
│   ├── index.ts                  # bootstrap: Bolt app, schedulers, MCP hub
│   ├── config.ts                 # env + workspace config loading
│   ├── slack/
│   │   ├── app.ts                # Bolt init (socket/http switch)
│   │   ├── events.ts             # message events, app_home_opened, reactions
│   │   ├── commands.ts           # /incident slash command family
│   │   ├── actions.ts            # button/modal handlers (block actions)
│   │   ├── views.ts              # modal + App Home view builders
│   │   └── blocks/               # Block Kit builders (pure functions)
│   │       ├── warroom.ts
│   │       ├── triage.ts
│   │       ├── statusUpdate.ts
│   │       ├── postmortem.ts
│   │       └── home.ts
│   ├── engine/
│   │   ├── signals.ts            # Signal Engine: RTS polling + classification
│   │   ├── incident.ts           # Incident state machine + orchestrator
│   │   ├── memory.ts             # similarity recall (embeddings + RTS)
│   │   ├── comms.ts              # stakeholder update drafting/cadence
│   │   ├── costMeter.ts
│   │   ├── postmortem.ts         # interviewer + synthesizer
│   │   └── drill.ts              # chaos drill simulator
│   ├── llm/
│   │   ├── client.ts             # Anthropic client wrapper w/ retries
│   │   └── prompts.ts            # ALL prompts centralized (see §7)
│   ├── mcp/
│   │   ├── hub.ts                # MCP client manager (connect, list, call)
│   │   └── servers/              # mock MCP servers (run as child processes)
│   │       ├── deploys.ts        # recent deploys, diffs
│   │       ├── observability.ts  # metrics, error rates, dashboards
│   │       └── oncall.ts         # on-call schedule, paging
│   ├── rts/
│   │   └── client.ts             # Real-Time Search API wrapper (+ fallback)
│   ├── db/
│   │   ├── schema.sql
│   │   ├── index.ts              # better-sqlite3 setup + queries
│   │   └── embeddings.ts         # store/search vectors (cosine, in-proc)
│   └── util/
│       ├── logger.ts             # pino
│       └── time.ts
├── scripts/
│   ├── seed.ts                   # seed historical incidents + embeddings
│   └── demo.ts                   # scripted demo driver (posts signal msgs)
└── test/
    ├── signals.test.ts
    ├── incident.test.ts
    └── memory.test.ts
```

---

## 4. Slack App Configuration

### 4.1 manifest.json (create exactly; adjust name/description freely)

```json
{
  "display_information": {
    "name": "Sentinel IC",
    "description": "AI incident commander that reads the room, runs the war room, and writes the postmortem.",
    "background_color": "#1a1d29"
  },
  "features": {
    "app_home": { "home_tab_enabled": true, "messages_tab_enabled": true },
    "bot_user": { "display_name": "Sentinel IC", "always_online": true },
    "assistant_view": { "assistant_description": "Your AI incident commander. Ask about active incidents, past incidents, or say 'start a drill'." },
    "slash_commands": [
      { "command": "/incident", "description": "Declare, manage, or drill incidents", "usage_hint": "declare | status | resolve | drill | config" }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read", "assistant:write",
        "channels:history", "channels:join", "channels:manage", "channels:read",
        "chat:write", "chat:write.public",
        "commands",
        "groups:history", "groups:read", "groups:write",
        "im:history", "im:read", "im:write",
        "pins:write", "bookmarks:write",
        "reactions:read", "reactions:write",
        "search:read.public",
        "users:read", "usergroups:read", "files:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened", "app_mention", "assistant_thread_started",
        "assistant_thread_context_changed",
        "message.channels", "message.groups", "message.im",
        "reaction_added"
      ]
    },
    "interactivity": { "is_enabled": true },
    "socket_mode_enabled": true
  }
}
```

> **Note:** `search:read.public` is the RTS-related scope name in current docs; if the API rejects it, check the live Slack docs for the RTS scope name at build time and update both manifest and README. Wrap all RTS calls behind `src/rts/client.ts` so a scope/API rename is a one-file fix, with the fallback in §6.3.

### 4.2 Environment (.env.example)

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...        # socket mode
SLACK_SIGNING_SECRET=...
SLACK_MODE=socket               # socket | http
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
DB_PATH=./data/sentinel.db
WATCH_CHANNELS=eng-general,deploys,support-escalations   # names or IDs
SIGNAL_POLL_SECONDS=45
SIGNAL_WINDOW_MINUTES=12
SIGNAL_THRESHOLD=0.72
UPDATE_CADENCE_MINUTES=15
COST_RATE_DEFAULT_PER_MIN=180   # USD, per-service overridable in config
MOCK_MCP=true                   # run bundled mock MCP servers
```

---

## 5. Data Model (schema.sql)

```sql
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,              -- INC-YYYYMMDD-XXX
  title TEXT NOT NULL,
  status TEXT NOT NULL,             -- detected|triage|active|monitoring|resolved|postmortem_done
  severity TEXT,                    -- SEV1..SEV4
  service TEXT,
  channel_id TEXT,
  triage_thread_ts TEXT,
  commander_user_id TEXT,
  comms_user_id TEXT,
  scribe_user_id TEXT,
  started_at INTEGER NOT NULL,
  detected_at INTEGER,
  resolved_at INTEGER,
  cost_estimate_usd REAL DEFAULT 0,
  is_drill INTEGER DEFAULT 0,
  summary TEXT,                     -- filled at resolution
  root_cause TEXT,
  resolution TEXT,
  postmortem_doc TEXT               -- final markdown
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- signal|status_change|action|message|mcp_data|update_sent
  actor TEXT,                       -- user id or 'sentinel'
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT, message_ts TEXT, user_id TEXT,
  text TEXT, score REAL, category TEXT,   -- latency|errors|outage|confusion|deploy_suspicion
  created_at INTEGER,
  incident_id TEXT                        -- null until clustered into an incident
);

CREATE TABLE IF NOT EXISTS embeddings (
  incident_id TEXT PRIMARY KEY REFERENCES incidents(id),
  vector BLOB NOT NULL                    -- Float32Array of summary embedding
);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT REFERENCES incidents(id),
  user_id TEXT, question TEXT, answer TEXT, asked_at INTEGER, answered_at INTEGER
);

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
```

**Embeddings:** Use Anthropic-generated structured "fingerprints" is not embedding; instead compute embeddings locally with `@xenova/transformers` (all-MiniLM-L6-v2, runs in-process, no extra API). Cosine similarity in `db/embeddings.ts`. Keep it simple: brute-force scan (incident counts are small).

---

## 6. Core Engines — Detailed Behavior

### 6.1 Signal Engine (`engine/signals.ts`) — the headline feature

**Inputs:** (a) live `message.channels` events from WATCH_CHANNELS; (b) RTS polling every `SIGNAL_POLL_SECONDS` with queries like `("is it just me" OR "anyone else" OR "500" OR "timeout" OR "down" OR "slow") in:#eng-general after:<window>` as a redundancy net.

**Pipeline per message:**
1. Cheap prefilter (regex/keyword list) to skip obvious noise — avoid LLM cost on every message.
2. LLM classification (batched, see prompt P1): returns `{is_signal, category, service_guess, confidence}`.
3. Store signals with score ≥ 0.5.
4. **Clustering tick** (every poll): group unassigned signals in the last `SIGNAL_WINDOW_MINUTES` by service_guess/category. If cluster weight (sum of confidences, distinct users ≥ 2) ≥ `SIGNAL_THRESHOLD` equivalent → **pre-incident**.
5. **Deploy correlation:** query MCP `deploys` server for deploys in last 30 min; if match on service, boost score and attach deploy metadata.

**Pre-incident action:** post a triage message in the source channel (threaded), NOT a new channel yet:

> ⚠️ **Possible incident brewing** — 3 people mentioned checkout latency in the last 9 min. Deploy `checkout-svc #482` shipped 14 min ago (`fix: connection pooling` by @dana).
> Similar past: INC-042 (83% match) — Redis pool exhaustion, resolved in 22 min.
> [Declare incident] [Snooze 15m] [Not an incident]

Buttons → `actions.ts`. "Not an incident" feeds a `config`-stored suppression list (simple keyword/service cooldown) so the agent visibly "learns."

### 6.2 Incident Core (`engine/incident.ts`)

**State machine:** `detected → triage → active → monitoring → resolved → postmortem_done`. All transitions logged to `timeline_events` and posted to the war room.

**On declare (button or `/incident declare`):**
1. Create channel `#inc-<yyyymmdd>-<slug>` (`channels:manage`), invite reporter + on-call (from MCP `oncall` server) + commander.
2. Post **war-room header** (Block Kit, `blocks/warroom.ts`): title, severity picker, role assignment buttons (Commander/Comms/Scribe — click to claim), status, elapsed timer, cost meter.
3. Pin header; add bookmarks: Runbook (from MCP docs lookup), Dashboard (MCP observability deep link), Timeline.
4. **Memory recall (§6.4)** posts the "similar incidents" card.
5. **MCP context pull:** recent deploys + current error-rate/latency snapshot from mock observability server; post as a context card.
6. Start schedulers: stakeholder update cadence (§6.5) + cost meter tick (§6.6).

**During incident:** every message in the war room is appended to `timeline_events` (kind=message). Reactions `📌` on any message promote it to a pinned timeline highlight. `/incident status <text>` sets a manual status line.

**On resolve (`/incident resolve` or button):** stop schedulers, LLM-summarize (prompt P4) → `summary/root_cause/resolution`, compute + store embedding, post resolution card, then kick off Postmortem Engine after 2 minutes.

### 6.3 RTS Wrapper (`rts/client.ts`)

Expose `searchMessages({query, channels?, after?}): Promise<RtsResult[]>`.
- Primary: Slack RTS API endpoint per current docs.
- **Fallback (mandatory):** if RTS call fails (scope/API availability in sandbox), transparently fall back to `conversations.history` scans over WATCH_CHANNELS with local filtering, and log a warning. The demo must never break because of RTS availability. Keep the interface identical so judges still see the RTS integration code path.

### 6.4 Memory / Similarity (`engine/memory.ts`)

On declare: build a query text from title + top signals → embed → cosine top-3 over `embeddings` (threshold 0.6). Additionally run an RTS query over past `#inc-*` channels for keyword echoes. LLM (prompt P3) fuses both into a card:

> 🧠 **Institutional memory** — 83% match: **INC-042** (Mar 12) *Redis connection pool exhaustion during checkout deploy.* Fixed by restarting pool + raising `max_connections` 128→512 (22 min). Resolver **@sam** — online now. [Open INC-042 postmortem] [Page @sam]

### 6.5 Comms Engine (`engine/comms.ts`)

Every `UPDATE_CADENCE_MINUTES` during `active`: LLM drafts an update from the last window of timeline events (prompt P5) in **three registers**: engineering, executive, customer-status. Post to war room as a card with tabs (overflow menu) + [Approve & send to #stakeholders] button. **Never auto-send externally without approval** — human-in-the-loop is a judging plus.

### 6.6 Cost Meter (`engine/costMeter.ts`)

`cost = rate_per_min(service) × minutes_since_start × severity_multiplier` (SEV1×1.0, SEV2×0.4, SEV3×0.1). Update the war-room header every 60s via `chat.update`. Config rates via `/incident config cost <service> <usd_per_min>`.

### 6.7 Postmortem Engine (`engine/postmortem.ts`)

1. Identify participants (distinct message authors in war room).
2. DM each: 2–3 **tailored** questions generated from their actual messages (prompt P6). Collect replies in DM thread (match by open interview rows).
3. After all reply or 24h timeout (demo: 5 min timeout flag), synthesize (prompt P7) into blameless postmortem markdown: Summary, Impact (incl. cost estimate), Timeline, Root cause, What went well, What went poorly, Action items (owner + due), Lessons.
4. Post as a Slack canvas if API available, else upload as a `.md` snippet via `files:write`, and store in `incidents.postmortem_doc`. Mark `postmortem_done`.

### 6.8 Drill Mode (`engine/drill.ts`)

`/incident drill [scenario]` → seeds a fake deploy into the mock MCP deploys server, then `scripts/demo.ts`-style posts 3–4 realistic trouble messages into a test channel from the bot (prefixed 🎭 DRILL), which flow through the real Signal Engine end-to-end with `is_drill=1`. This is both the training feature and the **demo recording mechanism**.

### 6.9 Assistant Surface (App Home + Assistant thread)

- **App Home:** active incidents list, last 5 resolved with cost + duration, MTTR trend line (text/emoji sparkline), buttons: Declare, Drill, Config.
- **Assistant threads / @mention Q&A:** natural-language over incident DB + RTS ("what broke last week?", "how did we fix the redis thing?") — LLM with retrieved context (prompt P8).

---

## 7. LLM Prompts (`llm/prompts.ts`) — implement all, keep centralized

All calls: Anthropic Messages API, `ANTHROPIC_MODEL`, temperature 0.2 for classification / 0.7 for drafting, strict JSON output where noted (instruct: "Respond ONLY with JSON, no markdown fences"). Wrap in retry (2 retries, exponential backoff) and JSON-fence stripping.

- **P1 signalClassify(messages[])** → per message `{is_signal:boolean, category, service_guess:string|null, confidence:0..1}`. System prompt must include examples of noise (lunch plans, jokes about "everything is down" memes) vs. real signals.
- **P2 clusterSummarize(signals[], deploys[])** → `{title, service, severity_suggestion, one_line}` for the triage card.
- **P3 memoryFuse(current, candidates[])** → ranked similar-incident card copy with match %, fix summary, resolver.
- **P4 resolveSummarize(timeline)** → `{summary, root_cause, resolution}`.
- **P5 statusUpdate(timelineWindow, register)** → text for engineering|executive|customer registers.
- **P6 interviewQuestions(participantMessages)** → 2–3 specific, blameless questions.
- **P7 postmortemSynthesize(incident, timeline, interviews)** → full markdown doc. Enforce blameless language ("the deploy lacked a rollback gate", never "Dana broke it").
- **P8 askIncidents(question, retrievedContext)** → grounded answer, cite incident IDs, say "I don't have record of that" when retrieval is empty.

---

## 8. Mock MCP Servers (`mcp/servers/`) — required for demo

Implement three small MCP servers with the MCP TypeScript SDK over stdio, spawned by `mcp/hub.ts` when `MOCK_MCP=true`:

1. **deploys** — tools: `list_recent_deploys({service?, minutes})`, `get_deploy_diff({id})`, `seed_deploy({...})` (used by drill). Backed by an in-memory array + a few seeded entries.
2. **observability** — tools: `get_error_rate({service})`, `get_latency_p95({service})`, `get_dashboard_url({service})`. Returns plausible numbers; during a drill, elevated numbers.
3. **oncall** — tools: `who_is_oncall({service})`, `page({user, message})` (page = the hub DMs that user in Slack; wire hub callback).

`hub.ts`: connect all servers on boot, expose `callTool(server, tool, args)`, list tools into logs at startup (nice for the demo video/architecture story). Design so real MCP server URLs (Datadog, PagerDuty) can be swapped in via config later — mention this in README.

---

## 9. Slash Command & Interaction Surface

```
/incident declare [title]        → declare modal (title, service, severity)
/incident status <text>          → set manual status line
/incident resolve                → resolution flow
/incident drill [scenario]       → run chaos drill (scenarios: redis|deploy|db|payment)
/incident config cost <svc> <n>  → set cost rate
/incident config watch <#chan>   → add channel to watch list (join it)
/incident help
```

Buttons/actions to implement in `actions.ts`: declare_incident, snooze_signal, dismiss_signal, claim_role_(commander|comms|scribe), set_severity, approve_update_(eng|exec|cust), page_resolver, open_past_incident, resolve_incident, start_drill.

---

## 10. Build Phases (execute in order; each phase must run before starting next)

**Phase 0 — Scaffold:** repo layout, tsconfig (strict), package.json (bolt, @anthropic-ai/sdk, @modelcontextprotocol/sdk, better-sqlite3, @xenova/transformers, pino, zod, vitest), .env.example, README skeleton, manifest.json. `npm run dev` boots Bolt in socket mode and logs "ready".

**Phase 1 — Incident Core happy path:** DB, `/incident declare` modal → channel creation → war-room header blocks → role claiming → timeline capture → `/incident resolve` → resolution card. No LLM yet (stub summaries).

**Phase 2 — LLM layer:** client wrapper + P4/P5; wire resolve summary + manual `/incident update` draft. Then P1/P2 signal classification.

**Phase 3 — Signal Engine:** live event listener + prefilter + classify + cluster + triage card + buttons. RTS wrapper with fallback.

**Phase 4 — MCP hub + mock servers:** deploy correlation in triage card, context card in war room, on-call invite + page button.

**Phase 5 — Memory:** embeddings module, seed script (§11), similar-incident card (P3).

**Phase 6 — Comms + Cost meter:** cadence scheduler, three-register drafts with approve buttons, cost ticker via chat.update.

**Phase 7 — Postmortem Engine:** interviews (P6), synthesis (P7), file/canvas output.

**Phase 8 — Drill mode + App Home + Assistant Q&A (P8).**

**Phase 9 — Hardening:** rate-limit safety (queue chat.update ≥1/sec/channel), error boundaries around every handler (never crash the socket), idempotency (don't double-declare from duplicate events — dedupe by event_id), tests for signals clustering, state machine transitions, embedding search. Finish README with setup + demo script.

---

## 11. Seed & Demo Tooling

**`scripts/seed.ts`:** insert 6–8 realistic historical incidents (varied services: checkout/redis, payments/db, auth/deploy, search/es) with summaries, root causes, resolutions, resolver user IDs (configurable to map to real workspace users), durations, costs — and compute embeddings. INC-042 must be the Redis pool exhaustion one so the flagship demo line works.

**`scripts/demo.ts` + drill scenarios:** the `redis` scenario must produce this 3-minute arc:
1. 🎭 drill seeds deploy `checkout-svc #482` → posts 3 user-style messages over ~40s in #eng-general ("checkout feels slow?", "yeah seeing timeouts", "500s on /cart").
2. Triage card appears with deploy correlation → click **Declare**.
3. War room auto-appears: header, roles, runbook bookmark, MCP context card, **INC-042 83% match** memory card, cost meter starts ticking.
4. Approve an executive update → posted to #stakeholders.
5. Resolve → resolution card → postmortem DM lands → show synthesized postmortem.

README must contain this demo script verbatim as a recording checklist.

---

## 12. Quality Bar & Judging Alignment

- **Technological implementation:** all three technologies visibly used (RTS in signals+memory, MCP hub with 3 servers, Slack AI/assistant surface + Anthropic reasoning). TypeScript strict, zod-validated inputs, tests on core engines, graceful degradation everywhere (RTS fallback, LLM retry, MCP-optional).
- **Design:** every user-facing surface is polished Block Kit (consistent emoji system: ⚠️ signal, 🚨 active, 🧠 memory, 💸 cost, 📋 postmortem); human-in-the-loop approvals; blameless language enforced.
- **Impact:** README quantifies the pitch — "cuts the chaotic first 10 minutes to under 60 seconds; every resolved incident makes the next one faster."
- **Idea:** README's "Why this doesn't exist yet" section: incumbents are alert-driven external platforms; Sentinel is conversation-driven and Slack-native — only possible with RTS.

## 13. Explicit Non-Goals (do not build)
- No web dashboard/frontend outside Slack. No real Datadog/PagerDuty OAuth. No multi-workspace/OrG support. No user-token message reading beyond bot-accessible channels. No auto-sending external comms without approval.
