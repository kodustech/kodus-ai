import { recoverRuleUuid } from './base-code-review-agent.provider';

/**
 * Regression guard for #1170: the kody_rules agent dropped an otherwise
 * correct suggestion because the LLM echoed the rule's 36-char UUID with a
 * single dropped character. recoverRuleUuid maps such a near-miss back to
 * the one known rule it unambiguously refers to.
 */
describe('recoverRuleUuid', () => {
    // The exact pair observed on the 2026-05-25 bitbucket run:
    const realUuid = '43063446-b519-4acc-9c4d-cc9eb8773a92';
    const corrupted = '43063446-b519-4acc-9c4d-cceb8773a92'; // dropped the '9'

    it('recovers a single-character corruption to the one known rule', () => {
        expect(recoverRuleUuid(corrupted, [realUuid])).toBe(realUuid);
    });

    it('returns the exact uuid when it is itself a known key edge case', () => {
        expect(recoverRuleUuid(realUuid, [realUuid])).toBe(realUuid);
    });

    it('refuses to recover when two known rules are both near (ambiguous)', () => {
        const a = '43063446-b519-4acc-9c4d-cc9eb8773a92';
        const b = '43063446-b519-4acc-9c4d-cc9eb8773a93'; // distance 1 from corrupted too
        expect(recoverRuleUuid(corrupted, [a, b])).toBeNull();
    });

    it('does not recover an unrelated uuid (distance > 2)', () => {
        const unrelated = 'ffffffff-0000-0000-0000-000000000000';
        expect(recoverRuleUuid('12345678-9abc-def0-1234-56789abcdef0', [unrelated])).toBeNull();
    });

    it('returns null when there are no known rules', () => {
        expect(recoverRuleUuid(corrupted, [])).toBeNull();
    });
});
