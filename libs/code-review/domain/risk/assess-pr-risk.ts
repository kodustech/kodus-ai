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
import { assessChangeRisk } from './assess-change-risk';
import { approvalPathsOf } from '../approval/approval-decision';
import type { RiskAssessmentResult, RiskSnapshot } from './risk-assessment';

export { approvalRiskOutputSchema as prRiskOutputSchema } from './assess-change-risk';

/** Kinds the model can judge by path alone: assets, docs, data, lockfiles, tests, fixtures. */
const JUDGEABLE_WITHOUT_DIFF =
    /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|svg|pdf|mp3|mp4|m4a|mov|webm|ogg|oga|wav|flac|woff2?|ttf|otf|eot|md|mdx|markdown|rst|adoc|txt|csv|tsv|json|jsonl|ndjson|snap)$|(?:^|\/)(?:yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock)$|(?:^|\/)(?:__tests__|__snapshots__|__fixtures__|tests?|specs?|fixtures?|testdata)\/|\.(?:test|spec)\.[^/.]+$/i;

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
    // Providers omit binary and oversized patches but keep the file. The model
    // judges an unseen file only when its path says what it holds, and is told
    // it did not see it; unseen code keeps the PR unavailable. Zero counters
    // cannot prove a pure rename: adapters can default missing counts to zero.
    const unseen = input.files.find(
        (file) =>
            (typeof file.patch !== 'string' || !file.patch.trim()) &&
            approvalPathsOf([file]).some(
                (path) => !JUDGEABLE_WITHOUT_DIFF.test(path),
            ),
    );
    if (unseen) {
        return unavailable(
            `Kody could not read the diff of ${unseen.filename}: the Git provider did not return it.`,
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
