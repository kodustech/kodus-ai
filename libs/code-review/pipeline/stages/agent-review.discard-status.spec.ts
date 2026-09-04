import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A discarded suggestion is a suggestion that was NOT sent, and it has to say
 * so.
 *
 * Every discard here stamped `priorityStatus` and nothing else, so the row
 * landed in Mongo with no `deliveryStatus` at all. The dashboard counts `sent`
 * on `DeliveryStatus.SENT` and `filtered` on `DeliveryStatus.NOT_SENT`, so a
 * statusless suggestion is counted by neither — it disappears.
 *
 * Measured in production over the 400 most recently updated pull requests:
 * 407 of 1255 suggestions (32.4%) carried no delivery status, across 20
 * organizations and 47% of the PRs that had any suggestion at all. `not_sent`
 * appeared zero times in that sample, which is why the "filtered" badge reads
 * 0 on every PR — it is structurally unable to be anything else.
 *
 * This is a source-level guard, deliberately. Driving the stage far enough to
 * observe the discard arrays needs the whole review pipeline stood up, and the
 * defect is not subtle behaviour — it is a field nobody typed. Checking that
 * every `allDiscarded.push` still names `deliveryStatus` catches the exact
 * regression at the exact place it happened, and fails loudly if someone adds
 * a sixth discard path without it.
 */

const SOURCE = [
    readFileSync(join(__dirname, 'agent-review.stage.ts'), 'utf8'),
    readFileSync(join(__dirname, 'create-file-comments.stage.ts'), 'utf8'),
].join('\n');

describe('agent-review.stage — discarded suggestions carry a delivery status', () => {
    // Each block runs from `allDiscarded.push({` to its closing `})`.
    const discardBlocks = (): string[] => {
        const blocks: string[] = [];
        // Both spellings: `allDiscarded` in the agent stage, and the
        // optional `allDiscardedSuggestions?.` in the comment stage.
        const marker = 'iscarded';
        let from = 0;
        for (;;) {
            const start = SOURCE.indexOf(marker, from);
            if (start === -1) break;
            const push = SOURCE.indexOf('.push({', start);
            if (push === -1 || push - start > 20) {
                from = start + marker.length;
                continue;
            }
            const end = SOURCE.indexOf('})', start);
            blocks.push(SOURCE.slice(start, end === -1 ? start : end));
            from = start + marker.length;
        }
        return blocks;
    };

    it('finds the discard sites it is meant to guard', () => {
        // If this number changes, a discard path was added or removed — read
        // the new one before updating the count.
        expect(discardBlocks()).toHaveLength(7);
    });

    it.each(discardBlocks().map((b, i) => [i, b] as const))(
        'discard site %i stamps deliveryStatus, not only priorityStatus',
        (_i, block) => {
            expect(block).toContain('priorityStatus:');
            expect(block).toContain(
                'deliveryStatus: DeliveryStatus.NOT_SENT,',
            );
        },
    );
});
