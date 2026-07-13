# Changes

## 2026-07-12

### Slack product polish

- Added a clearer App Home demo path: run drill, detect live Slack chatter, declare a war room, recall the last fix, and publish the postmortem.
- Improved pre-incident triage cards with an explicit "Why Sentinel flagged this" explanation.
- Made live workspace evidence visible in triage cards by labeling the Events API + Real-Time Search signal path.
- Added a war-room "Live incident timeline" card that shows recent incident activity directly in Slack.
- Updated the live timeline card when incident state changes, roles are claimed, severity/status changes, messages are recorded, or the incident is resolved.
- Added a "10m delay risk" estimate to the war-room header using the existing cost meter data.

### Postmortem demo robustness

- Improved postmortem participant selection so human timeline actors are interviewed even when they did not send normal war-room chat messages.
- This makes fast drill demos more reliable: the reporter/resolver can now receive postmortem DMs instead of producing a postmortem with zero interview participants.
- Drill users such as `drill-1` remain excluded from interviews.


### Tests

- Added App Home coverage for the demo path.
- Added triage card assertions for visible Real-Time Search evidence and the "Why Sentinel flagged this" explanation.
- Added incident timeline tests for initial war-room timeline creation and timeline refresh after recorded messages.
- Added postmortem regression coverage for actor-only interview participants.
- Verified the full suite passes with 71 tests.

### Runtime notes from Slack testing

- End-to-end Slack drill flow was tested with `/incident drill redis`.
- Confirmed war-room creation, memory recall, MCP deploy/observability context, stakeholder update approval, cost meter, live timeline, resolution card, and postmortem upload.
- OpenAI quota errors caused LLM-generated content to fall back to deterministic templates during testing; fallback behavior worked as designed.
- Slack Real-Time Search returned `not_allowed_token_type` for the bot token during testing, and Sentinel degraded to the history-scan fallback as designed.
