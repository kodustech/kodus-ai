import {
    normalizedPrText,
    prRiskConfigurationKey,
    prRiskDescriptionKey,
} from './risk-configuration';
import { createHash } from 'node:crypto';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { RiskCriterion } from '@libs/core/infrastructure/config/types/general/risk-assessment';
import type { CodeAreaRiskMap } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { assessChangeRisk, type RiskRule } from './assess-change-risk';
import { effectiveRiskCriteria } from './default-risk-criteria';
import { approvalPathsOf } from '../approval/approval-decision';
import type { RiskAssessmentResult, RiskSnapshot } from './risk-assessment';

export { approvalRiskOutputSchema as prRiskOutputSchema } from './assess-change-risk';

export interface AssessPrRiskInput {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    title: string;
    body?: string;
    files: FileChange[];
    criteria?: RiskCriterion[];
    language?: string;
    areaMap?: CodeAreaRiskMap | null;
    modelSlot?: NormalizedModel;
}

export function applicableRiskCriteria(
    criteria: readonly RiskCriterion[] | undefined,
    files: FileChange[],
): Array<RiskCriterion & { matchingPaths: string[] }> {
    const paths = approvalPathsOf(files);
    return (criteria ?? [])
        .filter((criterion) => criterion.enabled)
        .flatMap((criterion) => {
            const matchingPaths = paths.filter(
                (path) =>
                    (!criterion.includedFiles?.length ||
                        isFileMatchingGlob(path, criterion.includedFiles)) &&
                    !isFileMatchingGlob(path, criterion.excludedFiles ?? []),
            );
            return matchingPaths.length
                ? [{ ...criterion, matchingPaths }]
                : [];
        });
}

/** Where the old free-text `approvalRiskInstructions` lives once migrated. */
export const LEGACY_RISK_CRITERION_ID = 'legacy-risk';

/**
 * The rules a PR is judged against: the Kodus defaults with the team's
 * overrides, then its own rules, each enabled and matching a changed file. A
 * rule with file filters names the changed paths it applies to. The migrated
 * free-text instruction is not a rule; it travels as `riskContextFor`.
 */
export function riskRulesFor(
    criteria: readonly RiskCriterion[] | undefined,
    files: FileChange[],
): RiskRule[] {
    return applicableRiskCriteria(
        effectiveRiskCriteria(criteria).filter(
            (criterion) => criterion.id !== LEGACY_RISK_CRITERION_ID,
        ),
        files,
    ).map((criterion) => ({
        id: criterion.id,
        name: criterion.name!,
        instructions: criterion.instructions!,
        ...(criterion.includedFiles?.length || criterion.excludedFiles?.length
            ? { files: criterion.matchingPaths }
            : {}),
    }));
}

/**
 * The team's free-text guidance from before risk rules existed. It was context
 * for the judgment, which can relax risk as well as raise it, so it is sent as
 * context rather than as a rule whose match is risk.
 */
export function riskContextFor(
    criteria: readonly RiskCriterion[] | undefined,
    files: FileChange[],
): string | undefined {
    const legacy = criteria?.find(
        (criterion) => criterion.id === LEGACY_RISK_CRITERION_ID,
    );
    // A team that scoped or turned it off on the risk page is obeyed.
    if (!legacy?.instructions?.trim()) return undefined;
    return applicableRiskCriteria([legacy], files).length
        ? legacy.instructions.trim()
        : undefined;
}

/** Secrets never enter the persisted identity. A model/config/diff change invalidates reuse. */
export function prRiskSnapshot(input: AssessPrRiskInput): RiskSnapshot {
    const configurationKey = prRiskConfigurationKey(input);
    return {
        organizationId: input.organizationId,
        repositoryId: input.repositoryId,
        prNumber: input.prNumber,
        baseSha: input.baseSha,
        headSha: input.headSha,
        configurationKey,
        descriptionKey: prRiskDescriptionKey(input),
        assessmentKey: createHash('sha256')
            .update(
                JSON.stringify({
                    configurationKey,
                    ...normalizedPrText(input),
                    areaMapVersion: input.areaMap?.version,
                    files: input.files.map((file) => ({
                        path: file.filename,
                        previous: file.previous_filename,
                        status: file.status,
                        additions: file.additions,
                        deletions: file.deletions,
                        patch: file.patch,
                    })),
                }),
            )
            .digest('hex'),
    };
}

/** Production entry point shared by the pipeline, preview and evals. */
export async function assessPrRisk(
    input: AssessPrRiskInput,
): Promise<RiskAssessmentResult> {
    const snapshot = prRiskSnapshot(input);
    const unavailable = (reason: string): RiskAssessmentResult => ({
        status: 'unavailable',
        reason,
        snapshot,
    });
    if (!input.headSha || !input.baseSha || !input.files.length) {
        return unavailable('Kody could not verify the complete PR snapshot.');
    }
    const result = await assessChangeRisk({
        organizationId: input.organizationId,
        prNumber: input.prNumber,
        title: input.title,
        body: input.body,
        headSha: input.headSha,
        files: input.files,
        rules: riskRulesFor(input.criteria, input.files),
        teamContext: riskContextFor(input.criteria, input.files),
        language: input.language,
        areaMap: input.areaMap,
        modelSlot: input.modelSlot,
        trace: {
            baseSha: input.baseSha,
            assessmentKey: snapshot.assessmentKey,
        },
    });
    if (result.level === 'unknown') {
        return {
            ...unavailable(result.reason),
            ...(result.failure ? { failure: result.failure } : {}),
        };
    }
    return {
        status: 'assessed',
        riskIdentified: result.level !== 'low',
        reason: result.reason,
        ...(result.matchedRules?.length ? { rules: result.matchedRules } : {}),
        snapshot,
        areaMapVersion: result.areaMapVersion,
    };
}
