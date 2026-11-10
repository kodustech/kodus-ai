import {
    prRiskConfigurationKey,
    prRiskDescriptionKey,
} from './risk-configuration';
import { createHash } from 'node:crypto';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { RiskCriterion } from '@libs/core/infrastructure/config/types/general/risk-assessment';
import type { CodeAreaRiskMap } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { assessChangeRisk, buildChangeRiskDiff } from './assess-change-risk';
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
                    title: input.title,
                    body: input.body,
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
    // Providers can omit large/binary patches while retaining the file and its
    // line counts. An absent patch must not turn a partial diff into a judgment.
    // Zero counters cannot prove a pure rename: adapters can default missing counts to zero.
    if (
        input.files.some(
            (file) => typeof file.patch !== 'string' || !file.patch.trim(),
        )
    ) {
        return unavailable('Kody could not verify the complete PR diff.');
    }
    // The legacy assessor bounds its diff. The independent engine must never
    // classify an omitted part as safe, so an oversized snapshot stays unknown.
    if (buildChangeRiskDiff(input.files).length > 50_000) {
        return unavailable(
            'The complete PR diff exceeds the assessment limit.',
        );
    }
    const criteria = applicableRiskCriteria(input.criteria, input.files);
    const teamInstructions = criteria
        .map((criterion) =>
            criterion.id === 'legacy-risk'
                ? criterion.instructions
                : `${criterion.name} (files: ${criterion.matchingPaths.join(', ')}):\n${criterion.instructions}`,
        )
        .join('\n\n');
    const result = await assessChangeRisk({
        organizationId: input.organizationId,
        prNumber: input.prNumber,
        title: input.title,
        body: input.body,
        headSha: input.headSha,
        files: input.files,
        teamInstructions,
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
        snapshot,
        areaMapVersion: result.areaMapVersion,
    };
}
