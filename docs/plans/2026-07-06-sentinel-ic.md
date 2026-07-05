# Sentinel IC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Sentinel IC — a Slack-native AI incident commander (signal detection, war-room orchestration, institutional memory, postmortems) per `INCIDENT_COMMANDER_SPEC.md`.

**Architecture:** Node.js 20+/TypeScript strict, Slack Bolt (Socket Mode), SQLite via better-sqlite3, Anthropic SDK for LLM calls, MCP TypeScript SDK for a client hub + 3 mock stdio servers, local embeddings via @xenova/transformers with deterministic fallback. Engines (signals, incident, memory, comms, cost, postmortem, drill) are pure-ish modules wired by a bootstrap in `src/index.ts`.

**Tech Stack:** typescript, @slack/bolt, @anthropic-ai/sdk, @modelcontextprotocol/sdk, better-sqlite3, @xenova/transformers, pino, zod, vitest, tsx.

## Global Constraints (from spec)

- Repo lives at `sentinel-ic/` inside the working folder; spec file `INCIDENT_COMMANDER_SPEC.md` stays at folder root and is the source of truth for all behavior.
- TypeScript `strict: true`; zod-validate all external inputs (env, LLM JSON, MCP tool args).
- ESM project (`"type": "module"`), dev runner `tsx`, tests `vitest`.
- Env vars exactly as spec §4.2 (`SLACK_MODE=socket|http`, `MOCK_MCP=true`, `ANTHROPIC_MODEL=claude-sonnet-4-6`, etc.).
- Incident IDs: `INC-YYYYMMDD-XXX`. Statuses: `detected|triage|active|monitoring|resolved|postmortem_done`. Severities `SEV1..SEV4`.
- Emoji system: ⚠️ signal, 🚨 active, 🧠 memory, 💸 cost, 📋 postmortem. Drill messages prefixed 🎭 DRILL.
- Never auto-send external comms without approval. Blameless language in postmortems.
- Graceful degradation everywhere: RTS→conversations.history fallback, LLM retry (2 retries, exp backoff) + JSON-fence stripping, MCP-optional, embeddings model-load fallback to deterministic hash vectors.
- Every Slack handler wrapped in an error boundary (never crash the socket). Dedupe events by `event_id`. chat.update queued ≥1s apart per channel.
- Non-goals (§13): no web frontend, no real Datadog/PagerDuty OAuth, no multi-workspace, no user-token reads, no unapproved external sends.

---

### Task 0: Scaffold (spec Phase 0)

**Files:**
- Create: `sentinel-ic/package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `manifest.json` (verbatim from spec §4.1), `README.md` (skeleton), `src/index.ts`, `src/config.ts`, `src/util/logger.ts`, `src/util/time.ts`
- Test: none (boot check)

**Interfaces (Produces):**
- `config.ts`: `export const config: Config` — zod-parsed env: `{ slackBotToken, slackAppToken, slackSigningSecret, slackMode: 'socket'|'http', anthropicApiKey, anthropicModel, dbPath, watchChannels: string[], signalPollSeconds, signalWindowMinutes, signalThreshold, updateCadenceMinutes, costRateDefaultPerMin, mockMcp: boolean, appName }`; lenient defaults so tests run without a real .env.
- `logger.ts`: `export const logger` (pino).
- `time.ts`: `now(): number` (epoch seconds), `minutesAgo(n): number`, `fmtDuration(seconds): string`, `fmtUsd(n): string`.

**Steps:**
- [ ] `git init` in `sentinel-ic/`; write all scaffold files; `npm install`.
- [ ] `npm run build` (tsc) passes; commit `chore: scaffold sentinel-ic`.

### Task 1: DB layer (spec §5)

**Files:**
- Create: `src/db/schema.sql` (verbatim spec §5), `src/db/index.ts`, `src/db/embeddings.ts`
- Test: `test/db.test.ts` (covered indirectly by incident/memory tests; direct smoke test here)

**Interfaces (Produces):**
- `db/index.ts`: `openDb(path?): Database` (applies schema, `:memory:` for tests); typed row interfaces `Incident`, `TimelineEvent`, `Signal`, `Interview`; query helpers: `insertIncident`, `getIncident(id)`, `updateIncident(id, patch)`, `listIncidents({status?, limit?})`, `nextIncidentId(date)`, `addTimelineEvent(ev)`, `getTimeline(incidentId)`, `insertSignal`, `unclusteredSignalsSince(ts)`, `assignSignalsToIncident(ids, incidentId)`, `insertInterview`, `openInterviewFor(userId)`, `answerInterview(id, answer)`, `interviewsFor(incidentId)`, `getConfigValue(key)`, `setConfigValue(key, value)`.
- `db/embeddings.ts`: `storeEmbedding(db, incidentId, vec: Float32Array)`, `topKSimilar(db, vec, k, threshold): {incidentId, score}[]` (brute-force cosine).

**Steps:**
- [ ] Write failing vitest for id generation (`INC-20260706-001` then `-002`), state persistence, cosine top-k ordering; run (fails); implement; run (passes); commit.

### Task 2: Incident Core happy path (spec §6.2, Phase 1)

**Files:**
- Create: `src/engine/incident.ts`, `src/slack/app.ts`, `src/slack/commands.ts`, `src/slack/actions.ts`, `src/slack/views.ts`, `src/slack/events.ts`, `src/slack/blocks/warroom.ts`, `src/slack/blocks/statusUpdate.ts`
- Test: `test/incident.test.ts`

**Interfaces (Produces):**
- `engine/incident.ts`: `class IncidentCore` with `declare(opts: {title, service?, severity?, reporterId?, sourceChannelId?, signalIds?, isDrill?}): Promise<Incident>`, `transition(id, to: Status, actor): void` (validates legal transitions detected→triage→active→monitoring→resolved→postmortem_done, active↔monitoring, any→resolved), `resolve(id, actor): Promise<void>`, `setSeverity(id, sev)`, `claimRole(id, role: 'commander'|'comms'|'scribe', userId)`, `recordMessage(id, ev)`, `setStatusLine(id, text)`. Emits typed hooks: `onDeclared`, `onResolved` (subscribed later by memory/comms/cost/postmortem engines) via a simple `hooks` array API.
- `slack/app.ts`: `createSlackApp(config): App` — socket/http switch; `withBoundary(handlerName, fn)` error-boundary wrapper; `dedupeEvent(eventId): boolean`.
- `blocks/warroom.ts`: `warroomHeaderBlocks(incident, {costUsd, elapsed}): KnownBlock[]` with severity picker (`set_severity`), role claim buttons (`claim_role_commander|comms|scribe`), `resolve_incident` button.
- State machine test seam: IncidentCore takes a `SlackPort` interface (`createChannel`, `postMessage`, `updateMessage`, `pin`, `addBookmark`, `inviteUsers`, `dm`, `uploadFile`) so tests use a fake.

**Steps:**
- [ ] Failing tests: legal/illegal transitions, declare creates channel + header via fake port, role claim updates row, resolve stamps `resolved_at`; implement; pass; commit.

### Task 3: LLM layer (spec §7, Phase 2)

**Files:**
- Create: `src/llm/client.ts`, `src/llm/prompts.ts`
- Test: `test/llm.test.ts` (JSON-fence stripping, retry logic with injected fake transport)

**Interfaces (Produces):**
- `llm/client.ts`: `class LlmClient { complete(opts: {system, user, temperature, json?: boolean}): Promise<string>; completeJson<T>(opts, schema: ZodSchema<T>): Promise<T> }` — 2 retries exp backoff, strips ``` fences, zod-validates; constructor takes optional transport for tests; if no API key, throws `LlmUnavailableError` which callers catch to use stub copy.
- `llm/prompts.ts`: P1 `signalClassify(messages) → {results: {is_signal, category: 'latency'|'errors'|'outage'|'confusion'|'deploy_suspicion', service_guess: string|null, confidence}[]}`; P2 `clusterSummarize(signals, deploys) → {title, service, severity_suggestion, one_line}`; P3 `memoryFuse(current, candidates) → markdown card copy`; P4 `resolveSummarize(timeline) → {summary, root_cause, resolution}`; P5 `statusUpdate(window, register: 'engineering'|'executive'|'customer')`; P6 `interviewQuestions(participantMessages) → string[]` (2–3); P7 `postmortemSynthesize(incident, timeline, interviews) → markdown`; P8 `askIncidents(question, context) → grounded answer`. Each exported as `{system, buildUser(...), schema?}` so client stays generic. Temperatures: 0.2 classify / 0.7 drafting.

**Steps:**
- [ ] Failing tests for fence stripping + retry + schema reject→retry; implement; pass; wire P4 into `IncidentCore.resolve` (stub fallback when LLM unavailable); commit.

### Task 4: RTS wrapper + Signal Engine (spec §6.1, §6.3, Phase 3)

**Files:**
- Create: `src/rts/client.ts`, `src/engine/signals.ts`, `src/slack/blocks/triage.ts`
- Modify: `src/slack/events.ts` (message listener for WATCH_CHANNELS), `src/slack/actions.ts` (declare_incident, snooze_signal, dismiss_signal)
- Test: `test/signals.test.ts`

**Interfaces (Produces):**
- `rts/client.ts`: `searchMessages({query, channels?, after?}): Promise<RtsResult[]>` where `RtsResult = {channelId, ts, userId, text}`; tries Slack RTS endpoint (`search.messages`-family via WebClient apiCall), on any error logs warn once and falls back to `conversations.history` scans with local keyword filtering. Identical interface both paths.
- `engine/signals.ts`: `class SignalEngine { handleMessage(msg): Promise<void>; pollTick(): Promise<void>; clusterTick(): Promise<PreIncident|null> }`; `prefilter(text): boolean` exported pure (regex list: `is it just me|anyone else|\b5\d\d\b|timeout|down|slow|error|failing|broken|latency|degraded`); clustering: group unassigned signals in window by `service_guess||category`, cluster fires when `sum(confidence) >= SIGNAL_THRESHOLD*2` AND distinct users ≥ 2; suppression list from config store (keys `suppress:<service>` with cooldown ts). Deploy correlation via injected `McpPort.callTool('deploys','list_recent_deploys',...)` boosts score +0.15 and attaches metadata.
- `blocks/triage.ts`: `triageBlocks({summary, signals, deploy, similar}): KnownBlock[]` with buttons `declare_incident`, `snooze_signal`, `dismiss_signal` (⚠️ header).

**Steps:**
- [ ] Failing tests: prefilter noise vs signal, clustering threshold (2 users required, window expiry), suppression cooldown; implement with fake LLM + fake MCP; pass; commit.

### Task 5: MCP hub + mock servers (spec §8, Phase 4)

**Files:**
- Create: `src/mcp/hub.ts`, `src/mcp/servers/deploys.ts`, `src/mcp/servers/observability.ts`, `src/mcp/servers/oncall.ts`
- Modify: `src/engine/incident.ts` (context card + on-call invite on declare), `src/slack/actions.ts` (page_resolver)
- Test: `test/mcp.test.ts` (hub spawns deploys server over stdio, lists tools, `list_recent_deploys` returns seeded entries; `seed_deploy` then listed)

**Interfaces (Produces):**
- `hub.ts`: `class McpHub { connectAll(): Promise<void>; callTool(server: 'deploys'|'observability'|'oncall', tool, args): Promise<any>; listAllTools(): Promise<Record<string,string[]>>; close() }` — spawns servers as child processes (`tsx src/mcp/servers/<name>.ts`) over StdioClientTransport when `MOCK_MCP=true`; logs tool inventory at startup; `page` tool result triggers a hub callback that DMs the user via SlackPort.
- Servers use `McpServer` + zod tool schemas. deploys: `list_recent_deploys({service?, minutes})`, `get_deploy_diff({id})`, `seed_deploy({id?, service, title, author, minutes_ago?})`, seeded with 3 entries incl. `checkout-svc #481`. observability: `get_error_rate({service})`, `get_latency_p95({service})`, `get_dashboard_url({service})`; env `DRILL_ELEVATED=1` (set by seed_deploy side-channel file is overkill — instead deploys' `seed_deploy` is the drill trigger; observability elevates numbers when a recent seeded deploy exists — keep simple: `set_drill_mode({on})` tool). oncall: `who_is_oncall({service})` (static map + `ONCALL_USER_ID` env override), `page({user, message})`.

**Steps:**
- [ ] Failing hub test; implement servers + hub; pass; wire declare-time context card + on-call invite; commit.

### Task 6: Memory / similarity (spec §6.4, Phase 5)

**Files:**
- Create: `src/engine/memory.ts`, `scripts/seed.ts`
- Test: `test/memory.test.ts`

**Interfaces (Produces):**
- `engine/memory.ts`: `embedText(text): Promise<Float32Array>` — lazy-loads @xenova/transformers all-MiniLM-L6-v2; on load failure falls back to deterministic 384-dim hashed bag-of-words vector (log warn); `recallSimilar(db, queryText, k=3, threshold=0.6): Promise<SimilarIncident[]>` where `SimilarIncident = {incident, score}`; `memoryCard(current, similar, rtsEchoes): Promise<KnownBlock[]>` uses P3 with stub fallback (🧠 header, `open_past_incident` + `page_resolver` buttons).
- `scripts/seed.ts`: inserts 7 historical incidents (checkout/redis **INC-042** Redis pool exhaustion Mar 12 resolved 22min by @sam `max_connections 128→512`; payments/db; auth/deploy; search/es; +3 more) with summaries/root causes/resolutions/costs/durations, resolver ids configurable via `SEED_RESOLVER_*` env, computes embeddings. Runs via `npm run seed`.

**Steps:**
- [ ] Failing tests: fallback embedder deterministic + cosine self-similarity 1.0; seeded INC-042 is top match for "checkout redis pool timeouts"; implement; pass; wire recall into declare flow; commit.

### Task 7: Comms + Cost meter (spec §6.5–6.6, Phase 6)

**Files:**
- Create: `src/engine/comms.ts`, `src/engine/costMeter.ts`
- Modify: `src/slack/actions.ts` (`approve_update_eng|exec|cust`), `src/slack/blocks/statusUpdate.ts`
- Test: `test/costmeter.test.ts` (+ comms cadence unit test in same file)

**Interfaces (Produces):**
- `costMeter.ts`: `estimateCost({ratePerMin, startedAt, now, severity}): number` pure (multipliers SEV1×1.0 SEV2×0.4 SEV3×0.1 SEV4×0.05… spec gives ×0.1 for SEV3; use SEV4×0.05); `class CostMeter { start(incident), stop(id) }` updates header every 60s via queued `chat.update` (≥1s/channel queue lives in `slack/app.ts` `queuedUpdate()`).
- `comms.ts`: `class CommsEngine { start(incident), stop(id), draftNow(id) }` — every UPDATE_CADENCE_MINUTES during active: P5 in three registers, post card with overflow tabs + approve buttons; approve posts chosen register to `#stakeholders` (config `stakeholder_channel`). Never auto-sends.

**Steps:**
- [ ] Failing test for `estimateCost` math + scheduler start/stop bookkeeping (fake timers); implement; pass; commit.

### Task 8: Postmortem Engine (spec §6.7, Phase 7)

**Files:**
- Create: `src/engine/postmortem.ts`, `src/slack/blocks/postmortem.ts`
- Modify: `src/slack/events.ts` (DM replies matched to open interviews)
- Test: `test/postmortem.test.ts`

**Interfaces (Produces):**
- `postmortem.ts`: `class PostmortemEngine { kickoff(incidentId): Promise<void>; handleDmReply(userId, text): Promise<boolean>; finalize(incidentId): Promise<string> }` — kickoff 2min after resolve (config `POSTMORTEM_DELAY_SECONDS`, demo flag `POSTMORTEM_TIMEOUT_SECONDS` default 300); participants = distinct war-room authors; P6 questions per participant, DM'd; finalize on all-answered or timeout → P7 markdown (Summary, Impact incl. cost, Timeline, Root cause, What went well/poorly, Action items, Lessons); upload `.md` via `files:write` (canvas if available), store `postmortem_doc`, status `postmortem_done`.

**Steps:**
- [ ] Failing tests: participant extraction, DM reply→interview row matching, finalize-on-timeout with stub LLM; implement; pass; commit.

### Task 9: Drill mode + App Home + Assistant (spec §6.8–6.9, Phase 8)

**Files:**
- Create: `src/engine/drill.ts`, `src/slack/blocks/home.ts`, `scripts/demo.ts`
- Modify: `src/slack/events.ts` (`app_home_opened`, `assistant_thread_started`, `app_mention`), `src/slack/commands.ts` (`/incident drill|config|help`)
- Test: covered by signals tests (drill flows through real engine); `test/drill.test.ts` scenario shape check

**Interfaces (Produces):**
- `drill.ts`: `SCENARIOS: Record<'redis'|'deploy'|'db'|'payment', DrillScenario>` where `DrillScenario = {service, deploy: {...}, messages: {text, delayMs}[]}`; `runDrill(scenario, channelId)` seeds deploy via MCP, posts 🎭 DRILL-prefixed messages through the bot into the test channel; real SignalEngine picks them up; incidents flagged `is_drill=1`. redis scenario = spec §11 arc verbatim (deploy `checkout-svc #482` "fix: connection pooling" by @dana; "checkout feels slow?", "yeah seeing timeouts", "500s on /cart" over ~40s).
- `home.ts`: `homeBlocks({active, recent, mttrSparkline}): KnownBlock[]` + Declare/Drill/Config buttons.
- Assistant/@mention: retrieve context (DB query + `recallSimilar` + RTS) → P8 grounded answer, cite incident IDs, "I don't have record of that" on empty.
- `scripts/demo.ts`: CLI `npm run demo -- redis` → triggers drill in configured demo channel.

**Steps:**
- [ ] Implement + scenario-shape test; commit.

### Task 10: Hardening + README (spec Phase 9, §12)

**Files:**
- Modify: `src/slack/app.ts` (event dedupe LRU, chat.update queue verified), all handlers boundary-checked; `README.md` full: setup, architecture diagram, manifest install steps, demo recording checklist (spec §11 verbatim), "Why this doesn't exist yet" + impact pitch, real-MCP swap note.
- Test: full suite green.

**Steps:**
- [ ] Failing tests for dedupe + update queue spacing (fake timers); implement; `npm run build && npm test` all green; finish README; commit `docs: complete README + hardening`.

---

## Self-Review Notes

- Spec coverage: §4 manifest (T0), §5 schema (T1), §6.1 (T4), §6.2 (T2), §6.3 (T4), §6.4 (T6), §6.5–6.6 (T7), §6.7 (T8), §6.8–6.9 (T9), §7 (T3), §8 (T5), §9 commands spread across T2/T4/T7/T9, §10 order preserved, §11 (T6 seed + T9 demo), §12 (T10 + throughout), §13 respected.
- Cannot verify against a live Slack workspace here (no tokens): verification = strict build + unit tests + boot smoke test with mock env.
