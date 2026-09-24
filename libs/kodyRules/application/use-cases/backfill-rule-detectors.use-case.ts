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
import {
    KodyRuleContextNeed,
    KodyRulesType,
} from '../../domain/interfaces/kodyRules.interface';
import {
    compileAttemptIsCurrent,
    contextNeedIsCurrent,
} from '@libs/common/utils/kody-rules/compile-hash';

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
    /**
     * #1831 recompile accounting — only meaningful with `onlyMissing: false`,
     * which is how the fleet-wide re-scope sweep is run.
     */
    /** rules that HAD a detector and came back with a language scope. */
    rescoped: number;
    /** rules that HAD a detector and lost it (cosmetic / no longer compiles). */
    disabled: number;
    /** of those, the ones declined specifically as linter-owned formatting. */
    disabledCosmetic: number;
    /** rules that kept a detector but STILL carry no language scope. */
    stillUnscoped: number;
    /**
     * #1826 context-need accounting: how many processed rules ended up with
     * each need. The compile call decides both, so the sweep that arms
     * detectors also declares what every rule needs to see.
     */
    contextNeeds: Record<KodyRuleContextNeed, number>;
    /**
     * Of those, the ones that already carried that same need before the run.
     * A re-run over unchanged rule text puts every processed rule here, which
     * is what makes the sweep idempotent rather than merely repeatable.
     */
    contextNeedUnchanged: number;
    /**
     * #1826 step 1b accounting. The language scope now lives on the RULE, not
     * inside the detector plan, so this sweep is what carries it to the rules
     * that will never have a detector — measured on the fleet, 10.102 of
     * 10.918 active rules (92,5%). `fileScoped` counts the rules that came back
     * with a scope; `fileScopeUnchanged` the ones that already had the same
     * one, which is what makes a re-run idempotent.
     */
    fileScoped: number;
    fileScopeUnchanged: number;
    /**
     * INVARIANT CHECK, expected to stay 0.
     *
     * Two independent gates now stop a re-decided rule: this use-case filters
     * it out of `eligible`, and `compileAndSave` short-circuits before spending
     * a call. Both read the same `compileAttempt` hash, so a rule that reaches
     * the service and gets short-circuited means the two drifted apart — the
     * filter let through something the service then refused. Non-zero here is a
     * bug signal, not a savings report; the savings show up in `skipped`.
     */
    alreadyDecided: number;
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

        // `onlyMissing` means "we have not already decided this exact rule".
        //
        // It used to mean "has no detector", and that was the bug: the compiler
        // DECLINES most rules — 816 of 10.918 active rules carry a detector, so
        // 92,5% are declined — and a declined rule never gets one. So every one
        // of them came back eligible the next night, and the night after, at
        // roughly 2.000 model calls a night on the customer's own BYOK key,
        // forever, to reach the verdict we already had. The sweep's docblock
        // promised "only rules created since the last pass do any LLM work";
        // `compileAttempt` is what finally makes that true.
        //
        // The hash covers the rule text AND its examples, because the examples
        // are the compile gate — editing a snippet really can flip a verdict.
        const eligible = all.filter(
            (r) =>
                r.uuid &&
                r.status === 'active' &&
                r.type !== KodyRulesType.MEMORY &&
                // TWO settled questions, not one. A rule can have a current
                // compile attempt and a STALE context need — that is exactly
                // what happens when the classifier prompt is corrected and no
                // rule text changed. Asking only the first froze the whole
                // fleet on the old classifier's verdict.
                (!onlyMissing ||
                    !compileAttemptIsCurrent(r) ||
                    !contextNeedIsCurrent(r)),
        );
        const target = opts.limit ? eligible.slice(0, opts.limit) : eligible;

        const res: BackfillDetectorsResult = {
            total: all.length,
            processed: 0,
            compiled: 0,
            declined: 0,
            errored: 0,
            skipped: all.length - target.length,
            rescoped: 0,
            disabled: 0,
            disabledCosmetic: 0,
            stillUnscoped: 0,
            contextNeeds: {
                'diff-only': 0,
                'full-file': 0,
                'symbol-references': 0,
                'sibling-file': 0,
                'cited-file': 0,
            },
            contextNeedUnchanged: 0,
            fileScoped: 0,
            fileScopeUnchanged: 0,
            alreadyDecided: 0,
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
                        // Did this rule arrive with a detector? That is what
                        // makes it part of the #1831 fleet — the 424 unscoped
                        // detectors already armed across 129 orgs — as opposed
                        // to a rule being given a detector for the first time.
                        if (r.skipped) res.alreadyDecided++;
                        const hadDetector = !!rule.detector;
                        // Absent means the compile errored before the need was
                        // decided; `diff-only` is what review will use anyway.
                        const need = r.contextNeed ?? 'diff-only';
                        res.contextNeeds[need]++;
                        if (rule.contextNeed?.need === need) {
                            res.contextNeedUnchanged++;
                        }

                        // The scope is written for every rule the compile call
                        // touched, detector or not — that is the whole point of
                        // moving it off the detector plan.
                        const before = rule.fileScope?.extensions;
                        const after = r.fileScope;
                        if (after?.length) res.fileScoped++;
                        if (
                            before?.length &&
                            after?.length &&
                            before.join(',') === after.join(',')
                        ) {
                            res.fileScopeUnchanged++;
                        }
                        if (r.compiled) {
                            res.compiled++;
                            if (hadDetector && r.scoped) res.rescoped++;
                            if (!r.scoped) res.stillUnscoped++;
                        } else if (r.declineReason === 'error') {
                            res.errored++;
                        } else {
                            res.declined++;
                            // compileAndSave already cleared the stale detector;
                            // count it so the sweep can report what it disarmed.
                            if (hadDetector) {
                                res.disabled++;
                                if (r.declineReason === 'cosmetic') {
                                    res.disabledCosmetic++;
                                }
                            }
                        }
                    }
                },
            ),
        );

        this.logger.log({
            message: onlyMissing
                ? `Detector backfill complete for org`
                : `Detector re-scope sweep complete for org: ${res.rescoped} re-scoped, ${res.disabled} disarmed (${res.disabledCosmetic} cosmetic), ${res.stillUnscoped} still unscoped, ${res.processed - res.contextNeeds['diff-only']} needing context beyond the diff, ${res.fileScoped} language-scoped`,
            context: BackfillRuleDetectorsUseCase.name,
            metadata: { organizationAndTeamData, ...res },
        });
        return res;
    }
}
