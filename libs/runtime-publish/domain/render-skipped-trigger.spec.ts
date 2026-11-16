import { renderSkippedTriggerReply, SKIPPED_TRIGGER_REPLIES, type SkippedSetupState } from './render-skipped-trigger';

const SETUP_STATES: SkippedSetupState[] = ['setting_up', 'blocked', 'not_set_up', 'unknown'];

const answered = [
    ...Object.keys(SKIPPED_TRIGGER_REPLIES).map((reason) => [reason, renderSkippedTriggerReply(reason)] as const),
    ...SETUP_STATES.map((state) => [`environment_not_ready:${state}`, renderSkippedTriggerReply('environment_not_ready', state)] as const),
].filter((entry): entry is readonly [string, string] => entry[1] !== null);

describe('the answer to a skipped @kody runtime', () => {
    it.each(answered)('%s: one line, why nothing ran then one action, with any mention in code', (_reason, line) => {
        expect(line).not.toContain('\n');
        expect(line.split(/(?<=[.;])\s+/)).toHaveLength(2);
        // A bare @name would notify that account; outside backticks there is none.
        expect(line.replace(/`[^`]*`/g, '')).not.toMatch(/@\w/);
        expect(line).not.toMatch(/sorry|unfortunately/i);
    });

    it('stays silent for a commenter who may not ask, and for a reason it does not know', () => {
        expect(renderSkippedTriggerReply('commenter_not_allowed')).toBeNull();
        expect(renderSkippedTriggerReply('a_reason_added_later')).toBeNull();
    });

    // A developer told "it is off" got no way to the switch: the answer links
    // to the place it names when Kodus's address is known, and stays two sentences.
    it('links the off answer to the repository settings, and the no-environment answer to the environments', () => {
        const links = { settings: 'https://app.test/settings/code-review/r1/kody-runtime', environments: 'https://app.test/runtime/environments' };
        const off = renderSkippedTriggerReply('off', undefined, links)!;
        expect(off).toContain('(https://app.test/settings/code-review/r1/kody-runtime)');
        expect(off.split(/(?<=[.;])\s+/)).toHaveLength(2);
        expect(renderSkippedTriggerReply('no_environment', undefined, links)).toContain('(https://app.test/runtime/environments)');
        expect(renderSkippedTriggerReply('environment_not_ready', 'blocked', links)).toContain('(https://app.test/runtime/environments)');
        expect(renderSkippedTriggerReply('off')).toBe(SKIPPED_TRIGGER_REPLIES.off);
    });
});
