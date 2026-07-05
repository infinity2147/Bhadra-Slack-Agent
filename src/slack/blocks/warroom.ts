import type { Incident } from '../../db/index.js';
import { fmtDuration, fmtUsd } from '../../util/time.js';

/** Block Kit blocks are built as plain objects; Slack validates shape server-side. */
export type Block = Record<string, unknown>;

const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;

const STATUS_EMOJI: Record<string, string> = {
  detected: '⚠️',
  triage: '⚠️',
  active: '🚨',
  monitoring: '👀',
  resolved: '✅',
  postmortem_done: '📋',
};

export function warroomHeaderBlocks(
  incident: Incident,
  live: { costUsd: number; elapsed: number; statusLine?: string },
): Block[] {
  const drill = incident.is_drill ? ' · 🎭 DRILL' : '';
  const roles = [
    ['Commander', incident.commander_user_id],
    ['Comms', incident.comms_user_id],
    ['Scribe', incident.scribe_user_id],
  ]
    .map(([label, uid]) => `*${label}:* ${uid ? `<@${uid}>` : '_unclaimed_'}`)
    .join('   ');

  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${STATUS_EMOJI[incident.status] ?? '🚨'} ${incident.id} — ${incident.title}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:* ${incident.status}${drill}` },
        { type: 'mrkdwn', text: `*Severity:* ${incident.severity ?? 'unset'}` },
        { type: 'mrkdwn', text: `*Service:* ${incident.service ?? 'unknown'}` },
        { type: 'mrkdwn', text: `*Elapsed:* ⏱️ ${fmtDuration(live.elapsed)}` },
        { type: 'mrkdwn', text: `*Est. impact:* 💸 ${fmtUsd(live.costUsd)}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: roles } },
  ];

  if (live.statusLine) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📣 ${live.statusLine}` }],
    });
  }

  if (incident.status !== 'resolved' && incident.status !== 'postmortem_done') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'static_select',
          action_id: 'set_severity',
          placeholder: { type: 'plain_text', text: 'Severity', emoji: true },
          options: SEVERITIES.map((s) => ({ text: { type: 'plain_text', text: s }, value: `${incident.id}|${s}` })),
        },
        roleButton(incident.id, 'commander', '🧭 Claim Commander'),
        roleButton(incident.id, 'comms', '📣 Claim Comms'),
        roleButton(incident.id, 'scribe', '✍️ Claim Scribe'),
        {
          type: 'button',
          action_id: 'resolve_incident',
          style: 'primary',
          text: { type: 'plain_text', text: '✅ Resolve', emoji: true },
          value: incident.id,
          confirm: {
            title: { type: 'plain_text', text: 'Resolve incident?' },
            text: { type: 'mrkdwn', text: 'This stops updates and kicks off the postmortem flow.' },
            confirm: { type: 'plain_text', text: 'Resolve' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    });
  }
  return blocks;
}

function roleButton(incidentId: string, role: string, label: string): Block {
  return {
    type: 'button',
    action_id: `claim_role_${role}`,
    text: { type: 'plain_text', text: label, emoji: true },
    value: incidentId,
  };
}

export function resolutionBlocks(incident: Incident, duration: string): Block[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: `✅ ${incident.id} resolved`, emoji: true } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary:* ${incident.summary ?? '—'}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Root cause:* ${incident.root_cause ?? '—'}` },
        { type: 'mrkdwn', text: `*Resolution:* ${incident.resolution ?? '—'}` },
        { type: 'mrkdwn', text: `*Duration:* ⏱️ ${duration}` },
        { type: 'mrkdwn', text: `*Est. impact:* 💸 ${fmtUsd(incident.cost_estimate_usd)}` },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '📋 Postmortem interviews will start shortly. Sentinel will DM participants.' }],
    },
  ];
}
