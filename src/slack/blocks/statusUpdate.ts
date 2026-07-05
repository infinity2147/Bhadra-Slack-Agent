import type { Block } from './warroom.js';

export interface Drafts {
  engineering: string;
  executive: string;
  customer: string;
}

const LABELS: Record<keyof Drafts, { emoji: string; label: string; action: string }> = {
  engineering: { emoji: '🔧', label: 'Engineering', action: 'approve_update_eng' },
  executive: { emoji: '📊', label: 'Executive', action: 'approve_update_exec' },
  customer: { emoji: '🌐', label: 'Customer', action: 'approve_update_cust' },
};

/**
 * Three-register status update card (spec §6.5). Human-in-the-loop by design:
 * nothing leaves the war room until a human clicks Approve.
 */
export function statusUpdateBlocks(incidentId: string, drafts: Drafts, cadenceMinutes: number): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `📣 *Stakeholder update drafts* — nothing is sent until you approve.` },
    },
  ];
  for (const key of ['engineering', 'executive', 'customer'] as const) {
    const meta = LABELS[key];
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${meta.emoji} *${meta.label}*\n${drafts[key]}` },
        accessory: {
          type: 'button',
          action_id: meta.action,
          text: { type: 'plain_text', text: `Approve & send`, emoji: true },
          style: 'primary',
          value: incidentId,
          confirm: {
            title: { type: 'plain_text', text: `Send ${meta.label} update?` },
            text: { type: 'mrkdwn', text: 'This posts outside the war room.' },
            confirm: { type: 'plain_text', text: 'Send' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      },
    );
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Next drafts in ~${cadenceMinutes} min. Edit by replying, then approve.` }],
  });
  return blocks;
}
