import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IKodyRule } from '../interfaces/kodyRules.interface';

export const KODY_RULE_DETECTOR_COMPILER_TOKEN = Symbol(
    'KODY_RULE_DETECTOR_COMPILER',
);

/** Compiles a rule into a gated T0 detector and persists it (#1449). */
export interface IKodyRuleDetectorCompiler {
    /**
     * Compile the rule and persist the detector if the gate passes; clear a
     * stale detector when an edited rule no longer compiles. Best-effort — a
     * failure leaves the rule semantic. Returns whether a detector was stored.
     */
    compileAndSave(
        organizationAndTeamData: OrganizationAndTeamData,
        ruleUuid: string,
        rule: Partial<IKodyRule>,
    ): Promise<{ compiled: boolean; declineReason?: string }>;
}
