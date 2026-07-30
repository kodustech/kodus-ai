import {
    isGeneratedKodyRuleOrigin,
    resolveKodyRuleOrigin,
} from '@libs/common/utils/kody-rules/resolve-origin';
import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('resolveKodyRuleOrigin', () => {
    it('returns an explicit origin verbatim, ignoring legacyOrigin/sourcePath', () => {
        expect(
            resolveKodyRuleOrigin({
                origin: KodyRulesOrigin.MCP_AGENT,
                legacyOrigin: 'library',
                sourcePath: '.cursorrules',
            }),
        ).toBe(KodyRulesOrigin.MCP_AGENT);
    });

    it('infers LIBRARY from legacy origin', () => {
        expect(resolveKodyRuleOrigin({ legacyOrigin: 'library' })).toBe(
            KodyRulesOrigin.LIBRARY,
        );
    });

    it('infers REPO_FILE_SYNC from an IDE rule-file sourcePath (runtime, no legacyOrigin)', () => {
        expect(
            resolveKodyRuleOrigin({ sourcePath: '.cursor/rules/style.mdc' }),
        ).toBe(KodyRulesOrigin.REPO_FILE_SYNC);
    });

    it('prefers REPO_FILE_SYNC over GENERATED when both signals are present', () => {
        expect(
            resolveKodyRuleOrigin({
                legacyOrigin: 'generated',
                sourcePath: 'apps/web/.cursorrules',
            }),
        ).toBe(KodyRulesOrigin.REPO_FILE_SYNC);
    });

    it('infers PAST_REVIEWS from legacy generated origin without an IDE sourcePath', () => {
        expect(resolveKodyRuleOrigin({ legacyOrigin: 'generated' })).toBe(
            KodyRulesOrigin.PAST_REVIEWS,
        );
    });

    it('defaults to MANUAL for a legacy user rule', () => {
        expect(resolveKodyRuleOrigin({ legacyOrigin: 'user' })).toBe(
            KodyRulesOrigin.MANUAL,
        );
    });

    it('defaults to MANUAL when nothing is known (runtime fallback)', () => {
        expect(resolveKodyRuleOrigin({})).toBe(KodyRulesOrigin.MANUAL);
    });

    it('treats a non-IDE sourcePath as not REPO_FILE_SYNC', () => {
        expect(
            resolveKodyRuleOrigin({
                sourcePath: 'src/services/user.service.ts',
            }),
        ).toBe(KodyRulesOrigin.MANUAL);
    });
});

describe('isGeneratedKodyRuleOrigin', () => {
    it.each([
        KodyRulesOrigin.PAST_REVIEWS,
        KodyRulesOrigin.ONBOARDING_REPO_ANALYSIS,
        KodyRulesOrigin.MCP_AGENT,
    ])('treats %s as generated', (origin) => {
        expect(isGeneratedKodyRuleOrigin(origin)).toBe(true);
    });

    it.each([
        KodyRulesOrigin.MANUAL,
        KodyRulesOrigin.LIBRARY,
        KodyRulesOrigin.REPO_FILE_SYNC,
        undefined,
    ])('treats %s as not generated', (origin) => {
        expect(isGeneratedKodyRuleOrigin(origin)).toBe(false);
    });
});
