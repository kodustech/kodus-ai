import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRuleDetectorCompiler,
    KODY_RULE_DETECTOR_COMPILER_TOKEN,
} from '../../domain/contracts/kody-rule-detector-compiler.contract';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '../../domain/contracts/kodyRules.service.contract';
import { KodyRulesType } from '../../domain/interfaces/kodyRules.interface';

export interface BackfillDetectorsResult {
    /** total rules on the org */
    total: number;
    /** rules the compiler was actually run on */
    processed: number;
    /** rules that got a T0 detector */
    compiled: number;
    /** rules the gate/model kept semantic (correct, just no free path) */
    declined: number;
    /** rules where the compile call errored (left semantic) */
    errored: number;
    /** rules not eligible (inactive / memory / already have a detector) */
    skipped: number;
}

/**
 * Activate T0 on existing rules (#1449). The compile-on-save hook only fires
 * for new/edited rules, so rules created before this feature have no detector
 * and always run the semantic judge — correct, but they miss the free regex
 * path. This use-case sweeps an org's rules and compiles a gated detector for
 * each eligible one (reusing the same compile+gate+persist as the save hook).
 *
 * Two triggers, one engine:
 *   - BACKFILL: run once per org to activate the legacy (onlyMissing, no limit).
 *   - CONTINUOUS SWEEP: schedule on a cron so any rule that slipped through
 *     (or was created while the feature was off) eventually gets a detector.
 *
 * Idempotent: `onlyMissing` (default) skips rules that already have a detector,
 * so re-running is cheap. Model selection is inherited from the compiler
 * service (self-hosted -> BYOK; cloud -> system default) — the gate keeps a
 * weak model safe (fewer detectors, never a wrong one).
 */
@Injectable()
export class BackfillRuleDetectorsUseCase {
    private readonly logger = createLogger(BackfillRuleDetectorsUseCase.name);

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(KODY_RULE_DETECTOR_COMPILER_TOKEN)
        private readonly detectorCompiler: IKodyRuleDetectorCompiler,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        opts: {
            /** only rules without a detector (default true). */
            onlyMissing?: boolean;
            /** cap rules processed this run (for staged rollout). */
            limit?: number;
            /** parallel compile calls — keep gentle, these hit the LLM. */
            concurrency?: number;
        } = {},
    ): Promise<BackfillDetectorsResult> {
        const onlyMissing = opts.onlyMissing ?? true;
        const existing = await this.kodyRulesService.findByOrganizationId(
            organizationAndTeamData.organizationId,
        );
        const all = (existing?.rules ?? []) as any[];

        const eligible = all.filter(
            (r) =>
                r.uuid &&
                r.status === 'active' &&
                r.type !== KodyRulesType.MEMORY &&
                (!onlyMissing || !r.detector),
        );
        const target = opts.limit ? eligible.slice(0, opts.limit) : eligible;

        const res: BackfillDetectorsResult = {
            total: all.length,
            processed: 0,
            compiled: 0,
            declined: 0,
            errored: 0,
            skipped: all.length - target.length,
        };

        const concurrency = Math.max(1, opts.concurrency ?? 3);
        let i = 0;
        await Promise.all(
            Array.from(
                { length: Math.min(concurrency, target.length || 1) },
                async () => {
                    while (i < target.length) {
                        const rule = target[i++];
                        res.processed++;
                        const r = await this.detectorCompiler.compileAndSave(
                            organizationAndTeamData,
                            rule.uuid,
                            rule,
                        );
                        if (r.compiled) res.compiled++;
                        else if (r.declineReason === 'error') res.errored++;
                        else res.declined++;
                    }
                },
            ),
        );

        this.logger.log({
            message: `Detector backfill complete for org`,
            context: BackfillRuleDetectorsUseCase.name,
            metadata: { organizationAndTeamData, ...res },
        });
        return res;
    }
}
