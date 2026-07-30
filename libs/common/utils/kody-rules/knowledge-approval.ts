import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { isGeneratedKodyRuleOrigin } from './resolve-origin';

export type KodyKnowledgeApprovalConfig = {
    enabled: boolean;
};

/**
 * Whether a rule/memory of the given origin needs approval before it becomes
 * active, under the resolved (global/repo/directory-merged) config. When
 * enabled, generated knowledge AND auto-synced IDE rule files
 * (`repo_file_sync`) require approval; manual/library/CLI origins remain
 * active. `repo_file_sync` is gated but deliberately kept out of
 * `isGeneratedKodyRuleOrigin` — it's imported, not machine-generated, and that
 * helper drives origin display / centralized-sync classification elsewhere.
 */
export function requiresKnowledgeApproval(
    config: KodyKnowledgeApprovalConfig | undefined,
    origin: KodyRulesOrigin,
): boolean {
    if (!config?.enabled) {
        return false;
    }

    return (
        isGeneratedKodyRuleOrigin(origin) ||
        origin === KodyRulesOrigin.REPO_FILE_SYNC
    );
}
