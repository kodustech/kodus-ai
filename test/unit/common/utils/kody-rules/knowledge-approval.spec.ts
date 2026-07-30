import { requiresKnowledgeApproval } from '@libs/common/utils/kody-rules/knowledge-approval';
import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('requiresKnowledgeApproval', () => {
    it('never requires approval when disabled (or unset)', () => {
        for (const origin of Object.values(KodyRulesOrigin)) {
            expect(requiresKnowledgeApproval(undefined, origin)).toBe(false);
            expect(
                requiresKnowledgeApproval({ enabled: false }, origin),
            ).toBe(false);
        }
    });

    describe('when enabled, with no per-origin overrides', () => {
        const config = { enabled: true };

        it.each([
            KodyRulesOrigin.PAST_REVIEWS,
            KodyRulesOrigin.ONBOARDING_REPO_ANALYSIS,
            KodyRulesOrigin.MCP_AGENT,
        ])('requires approval for generated origin %s', (origin) => {
            expect(requiresKnowledgeApproval(config, origin)).toBe(true);
        });

        it('requires approval for repo_file_sync (auto-synced IDE rule files)', () => {
            expect(
                requiresKnowledgeApproval(
                    config,
                    KodyRulesOrigin.REPO_FILE_SYNC,
                ),
            ).toBe(true);
        });

        it.each([
            KodyRulesOrigin.MANUAL,
            KodyRulesOrigin.LIBRARY,
            KodyRulesOrigin.CLI,
        ])(
            'does not require approval for user/imported origin %s',
            (origin) => {
                expect(requiresKnowledgeApproval(config, origin)).toBe(false);
            },
        );
    });
});
