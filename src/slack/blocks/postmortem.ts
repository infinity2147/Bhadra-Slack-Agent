import type { Incident } from '../../db/index.js';
import type { Block } from './warroom.js';

export function postmortemReadyBlocks(incident: Incident, interviewCount: number): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 *Postmortem ready for ${incident.id}* — synthesized from the timeline and ${interviewCount} interview answer${interviewCount === 1 ? '' : 's'}. Blameless by design.`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'The full document is attached above as markdown and stored in incident memory for future recall.' }],
    },
  ];
}
