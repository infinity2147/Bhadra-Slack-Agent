import type { PreIncident } from '../../engine/signals.js';
import { fmtDuration, now } from '../../util/time.js';
import type { Block } from './warroom.js';

export function triageBlocks(pre: PreIncident): Block[] {
  const users = [...new Set(pre.signals.map((s) => s.user_id))];
  const categories = [...new Set(pre.signals.map((s) => s.category).filter(Boolean))];
  const lines: string[] = [`⚠️ *Possible incident brewing* — ${pre.one_line}`];

  if (pre.deploy) {
    const ago = fmtDuration(now() - pre.deploy.deployed_at);
    lines.push(`🚢 Deploy \`${pre.deploy.service} ${pre.deploy.id}\` shipped ${ago} ago (\`${pre.deploy.title}\` by @${pre.deploy.author}).`);
  }
  if (pre.similarLine) lines.push(`🧠 ${pre.similarLine}`);
  lines.push(
    `🔎 *Why Sentinel flagged this:* ${users.length} distinct humans, ${pre.signals.length} live workspace signals${categories.length ? ` (${categories.join(', ')})` : ''}, service \`${pre.service}\`${pre.deploy ? ', recent deploy correlation' : ''}.`,
  );

  const blocks: Block[] = [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Live workspace evidence via Events API + Real-Time Search · signals from ${users.map((u) => `<@${u}>`).join(', ')} · suggested ${pre.severity_suggestion}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'declare_incident',
          style: 'danger',
          text: { type: 'plain_text', text: '🚨 Declare incident', emoji: true },
          value: pre.key,
        },
        {
          type: 'button',
          action_id: 'snooze_signal',
          text: { type: 'plain_text', text: '😴 Snooze 15m', emoji: true },
          value: pre.key,
        },
        {
          type: 'button',
          action_id: 'dismiss_signal',
          text: { type: 'plain_text', text: '✋ Not an incident', emoji: true },
          value: pre.key,
        },
      ],
    },
  ];
  return blocks;
}
