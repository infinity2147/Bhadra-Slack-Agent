# 🛡️ Sentinel IC — Slack-Native AI Incident Commander

> Reads the room before pagers fire. Runs the war room. Remembers every incident. Writes the postmortem.

Sentinel IC is a Slack agent that detects trouble from **human chatter** in your engineering channels — *"checkout is slow for anyone else?"* — correlates it with recent deploys, opens a pre-incident triage thread **before monitoring alerts fire**, then autonomously runs the entire incident lifecycle inside Slack.

Built for the **Slack Agent Builder Challenge** (New Slack Agent track).

## Why this doesn't exist yet

Incumbents (PagerDuty, Rootly, FireHydrant, incident.io) are **alert-driven external platforms** that integrate *into* Slack. They react to monitoring alerts; they don't read the room, and they can't reason over the conversational history of how your team actually fixed things. Sentinel is **conversation-driven and Slack-native** — the earliest incident signal is almost always a human saying "is it just me?", and only Slack's Real-Time Search makes that signal reachable.

**Impact:** the chaotic first 10 minutes of an incident (who noticed? where's the channel? who's on call? where's the runbook? has this happened before?) collapse to under 60 seconds — and every resolved incident makes the next one faster, because Sentinel remembers.

## The three qualifying technologies

| Technology | Where it's used |
|---|---|
| **Slack AI capabilities** | First-class Assistant surface — `assistant.threads.setSuggestedPrompts` (clickable starters), `setStatus` ("is thinking…" while it answers), `setTitle` — plus App Home, AI-generated triage cards, status updates, postmortems (`assistant_view`, `assistant_thread_started`, App Home tab) |
| **MCP server integration** | `src/mcp/hub.ts` client hub + three MCP servers over stdio: deploys, observability, on-call/paging (mocks bundled for the demo; swap real Datadog/PagerDuty/GitHub MCP servers via `ServerCommand` config). Per-server connect isolation: one server failing to spawn degrades that capability, not the whole hub |
| **Real-Time Search (RTS) API** | Early-warning signal polling over watched channels + historical incident echo recall + **live workspace-echo grounding in the assistant** (Q&A fuses fresh RTS hits with incident memory). `src/rts/client.ts`, with a mandatory `conversations.history` fallback and auto re-probe so a transient failure never permanently downgrades the demo |

Plus the **Anthropic API (Claude)** for all reasoning: signal classification, cluster summarization, memory fusion, three-register comms drafting, blameless interviewing, postmortem synthesis, and grounded Q&A — all prompts centralized in [src/llm/prompts.ts](src/llm/prompts.ts).

## What it does

1. **⚠️ Pre-incident detection ("reads the room")** — live message events + RTS polling → cheap regex prefilter → Claude classification → clustering (≥2 distinct humans, confidence-weighted) → deploy correlation via MCP → threaded triage card with `[Declare] [Snooze 15m] [Not an incident]`. Dismissals feed a suppression list, so the agent visibly learns.
2. **🧠 Institutional memory** — on declare, local embeddings (all-MiniLM-L6-v2, in-process) + RTS keyword echoes over past incidents → *"83% match: INC-042 (Mar 12), Redis pool exhaustion — fixed by restarting pool + raising max_connections, 22 min. Resolver @sam is online. [Page @sam]"*
3. **🚨 Autonomous war room** — auto-creates `#inc-YYYYMMDD-service`, invites reporter + on-call (MCP), posts & pins the live header (severity picker, claim-role buttons, elapsed timer, 💸 cost meter), adds runbook/dashboard/timeline bookmarks, posts an MCP live-context card (error rate, p95, recent deploys), captures every message to the timeline. 📌 reactions promote highlights.
4. **📣 Stakeholder translation layer** — every 15 minutes Claude drafts the same update in three registers (engineering / executive / customer). **Nothing sends without a human clicking Approve.**
5. **💸 Live cost meter** — `rate/min × minutes × severity multiplier`, ticking in the header via rate-limited `chat.update`. Configure with `/incident config cost checkout 400`.
6. **📋 Blameless postmortem interviewer** — after resolve, DMs each participant 2–3 questions tailored to *their actual messages*, then synthesizes timeline + interviews into a blameless postmortem markdown doc, uploaded to the war room and stored in memory for future recall.
7. **🎭 Chaos drill mode** — `/incident drill redis` seeds a fake deploy into the mock MCP server, elevates mock metrics, posts realistic trouble messages, and drives the **real pipeline** end-to-end. Training feature *and* demo recording mechanism.
8. **🤖 Assistant Q&A** — open the Assistant panel (it greets you with clickable suggested prompts and shows an "is thinking…" status while it works), DM the bot, or @mention it: *"what broke last week?"*, *"how did we fix the redis thing?"*, *"anything on fire right now?"* Answers fuse **live workspace chatter (via RTS)** with retrieved incident memory, cite incident IDs, and say "I don't have record of that" rather than guessing.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                            SLACK WORKSPACE                          │
│  #deploys  #eng-general  #alerts   #inc-2026-07-06-checkout  DMs   │
└───────▲───────────▲──────────▲──────────────▲──────────────▲──────┘
        │  Events API / Socket Mode / RTS API / Web API
┌───────┴───────────┴──────────┴──────────────┴──────────────┴──────┐
│                        SENTINEL IC SERVICE (Node.js + Bolt)        │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────┐  │
│  │ Signal Engine │  │ Incident Core │  │ Postmortem Engine      │  │
│  │ (RTS poller + │  │ (state machine│  │ (interviewer + doc     │  │
│  │  event stream │  │  + war room   │  │  synthesizer)          │  │
│  │  classifier)  │  │  orchestrator)│  │                        │  │
│  └──────┬───────┘  └──────┬────────┘  └──────────┬─────────────┘  │
│  ┌──────┴─────────────────┴──────────────────────┴─────────────┐  │
│  │             LLM Layer (Anthropic API, Claude)                │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│  ┌───────────────┐  ┌───────┴────────┐  ┌────────────────────┐    │
│  │ MCP Client Hub │  │ Memory Store   │  │ Schedulers         │    │
│  │ deploys · obs ·│  │ SQLite + local │  │ (comms cadence,    │    │
│  │ oncall (stdio) │  │ embeddings     │  │ cost ticks, polls) │    │
│  └───────────────┘  └────────────────┘  └────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

State machine: `detected → triage → active ⇄ monitoring → resolved → postmortem_done`, every transition logged to the timeline.

**Stack:** Node 20+, TypeScript (strict), Slack Bolt (Socket Mode; `SLACK_MODE=http` for production), better-sqlite3 (zero-ops), `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `@xenova/transformers` (in-process embeddings with a deterministic hashed fallback — no extra API).

**Graceful degradation everywhere:** RTS → history-scan fallback · LLM → retry ×2 then deterministic copy · embeddings model → hashed vectors · MCP optional · every handler in an error boundary · event-id dedupe · `chat.update` rate-gated ≥1s/channel.

## Setup (10 minutes)

### 1. Create the Slack app
1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → paste [manifest.json](manifest.json).
2. **Basic Information → App-Level Tokens** → generate a token with `connections:write` scope → this is `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** to your workspace → copy the **Bot User OAuth Token** (`xoxb-…`).

> **RTS scope note:** the manifest requests `search:read.public` (the RTS scope name in current docs). If your sandbox rejects it, check the live Slack docs for the current RTS scope name and update the manifest — all RTS calls are wrapped in [src/rts/client.ts](src/rts/client.ts) so an API rename is a one-file fix, and the built-in fallback keeps everything working meanwhile.

### 2. Configure & run
```bash
npm install
cp .env.example .env       # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ANTHROPIC_API_KEY
npm run seed               # load 7 historical incidents (incl. INC-042) + embeddings
npm run dev                # ⚡ Sentinel IC ready — reading the room
```

Create the channels you want watched (default: `#eng-general`, `#deploys`, `#support-escalations` — see `WATCH_CHANNELS`) plus `#stakeholders`. Sentinel joins watched channels on boot.

Optional env: `ONCALL_USER_ID` (who the mock on-call server returns — set it to your own Slack user ID for the demo), `SEED_RESOLVER_SAM` (map INC-042's resolver to a real user).

### 3. Commands
```
/incident declare [title]        → declare modal (title, service, severity)
/incident status <text>          → set manual status line
/incident resolve                → resolution flow
/incident drill [scenario]       → chaos drill (redis | deploy | db | payment)
/incident config cost <svc> <n>  → set 💸 cost rate (USD/min)
/incident config watch <#chan>   → add channel to watch list
/incident help
```

## 🎬 Demo recording checklist (the 3-minute arc)

The `redis` drill produces this arc (spec §11) — record it end-to-end:

1. 🎭 drill seeds deploy `checkout-svc #482` → posts 3 user-style messages over ~40s in `#eng-general` ("checkout feels slow?", "yeah seeing timeouts", "500s on /cart").
   ```
   /incident drill redis        (run it in #eng-general)
   ```
2. **Triage card appears** with deploy correlation ("Deploy `checkout-svc #482` shipped 14 min ago — `fix: connection pooling` by @dana") → click **🚨 Declare incident**.
3. **War room auto-appears**: pinned header with roles/severity/elapsed, runbook + dashboard bookmarks, 📊 MCP context card (elevated error rate & p95), **🧠 INC-042 83% match memory card** with resolver page button, 💸 cost meter ticking.
4. Wait for (or trigger) the 📣 three-register update card → **Approve the executive update** → it posts to `#stakeholders`.
5. `/incident resolve` → ✅ resolution card (Claude-summarized root cause) → **postmortem DM lands** with tailored questions → answer them → 📋 synthesized blameless postmortem uploads to the war room.

Tips: set `UPDATE_CADENCE_MINUTES=1` and `POSTMORTEM_DELAY_SECONDS=5`, `POSTMORTEM_TIMEOUT_SECONDS=60` in `.env` for a snappy recording. `npm run demo -- redis` posts the trouble messages from a second connection if you prefer driving the arc without the drill command.

## Swapping in real MCP servers

The hub spawns any `{command, args, env}` per server ([src/mcp/hub.ts](src/mcp/hub.ts)). Point `deploys` at a GitHub MCP server, `observability` at Datadog's, and `oncall` at PagerDuty's — the engines only speak `callTool(server, tool, args)`, so no engine code changes.

## Tests

```bash
npm test        # 60 tests: state machine, clustering, memory recall, MCP hub (real stdio), postmortems, hardening
npm run build   # strict TypeScript
```

## Repository layout

See [INCIDENT_COMMANDER_SPEC.md](INCIDENT_COMMANDER_SPEC.md) (§3) — the layout matches: engines in `src/engine/`, Block Kit builders in `src/slack/blocks/`, prompts centralized in `src/llm/prompts.ts`, mock MCP servers in `src/mcp/servers/`, seed/demo tooling in `scripts/`.

## Non-goals (by design)
No web dashboard outside Slack · no real Datadog/PagerDuty OAuth (mock MCP for the demo, swappable) · no multi-workspace support · no user-token message reading · **no external comms without human approval**.
