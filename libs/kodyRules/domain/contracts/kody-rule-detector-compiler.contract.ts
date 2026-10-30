import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRule,
    KodyRuleContextNeed,
} from '../interfaces/kodyRules.interface';

export const KODY_RULE_DETECTOR_COMPILER_TOKEN = Symbol(
    'KODY_RULE_DETECTOR_COMPILER',
);

/** Compiles a rule into a gated T0 detector and persists it (#1449). */
export interface IKodyRuleDetectorCompiler {
    /**
     * Compile the rule and persist the detector if the gate passes; clear a
     * stale detector when an edited rule no longer compiles. Best-effort — a
     * failure leaves the rule semantic. Returns whether a detector was stored.
     *
     * `scoped` reports whether the stored detector carries a language scope
     * (issue #1831), so a backfill sweep can tell a re-scoped detector from one
     * that is still unscoped without re-reading every rule.
     *
     * `contextNeed` is what the SAME call decided the rule must see beyond the
     * diff (issue #1826) — reported so a backfill sweep can count needs per org
     * without re-reading every rule. `diff-only` whenever the model was not
     * confident, which is today's behavior.
     *
     * `fileScope` is the rule-level language scope that same call inferred
     * (#1826 step 1b), reported for the same reason. Distinct from `scoped`,
     * which is about the DETECTOR's copy and is therefore only ever set for
     * the 7,5% of rules that have one.
     */
    compileAndSave(
        organizationAndTeamData: OrganizationAndTeamData,
        ruleUuid: string,
        rule: Partial<IKodyRule>,
    ): Promise<{
        compiled: boolean;
        declineReason?: string;
        scoped?: boolean;
        contextNeed?: KodyRuleContextNeed;
        fileScope?: string[];
        /**
         * True when no model call was made because an identical rule text and
         * examples had already been decided. The other fields then repeat what
         * was stored, so a caller counting outcomes stays correct either way.
         */
        skipped?: boolean;
    }>;
}
