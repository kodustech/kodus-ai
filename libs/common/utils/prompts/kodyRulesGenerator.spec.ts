import {
    prompt_KodyRulesGeneratorDuplicateFilterUser,
    prompt_KodyRulesGeneratorUser,
} from './kodyRulesGenerator';

// `examples` is optional in the generator schema; a rule without it made the
// prompt builders throw "Cannot read properties of undefined (reading 'map')"
// and the whole Kody Rules generation run for the org failed.
describe('kodyRulesGenerator prompts — rules without examples', () => {
    const rule = {
        uuid: 'r-1',
        title: 'No console.log',
        rule: 'Use the logger',
        severity: 'medium',
    } as any;

    it('builds the generator prompt when a library rule has no examples', () => {
        expect(() =>
            prompt_KodyRulesGeneratorUser({ comments: [], rules: [rule] }),
        ).not.toThrow();
    });

    it('builds the duplicate-filter prompt when a new rule has no examples', () => {
        expect(() =>
            prompt_KodyRulesGeneratorDuplicateFilterUser({
                existingRules: [],
                newRules: [rule],
            }),
        ).not.toThrow();
    });
});
