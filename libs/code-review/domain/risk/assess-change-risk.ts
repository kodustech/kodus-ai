import { z } from 'zod';

import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { CodeAreaRiskMap } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import {
    classifyLLMError,
    getClassification,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';
import { getModelId } from '@libs/llm/managed-slot';
import { resolveContextWindowWithSource } from '@libs/llm/model-context-window';
import { zodToStrictWireSchema } from '@libs/llm/strict-wire-schema';
import { createLogger } from '@libs/core/log/logger';
import { CHANGE_RISK_PROMPT } from './change-risk-prompt';
import { estimateRiskPromptTokens } from './estimate-risk-prompt-tokens';

/** Internal judgment retained for compatibility; public PR risk is binary. */
export interface ChangeRiskAssessment {
    level: 'low' | 'medium' | 'high' | 'unknown';
    reason: string;
    reviewedHeadSha: string;
    areaMapVersion?: string;
    failure?: {
        category: string;
        errorName: string;
        httpStatus?: number;
        code?: 'diff_too_large';
    };
}

export const approvalRiskOutputSchema = z.object({
    level: z.enum(['low', 'medium', 'high']),
    // Length alone must not discard a valid risk judgment.
    reason: z.string().min(8),
});

const MAX_REASON_CHARS = 2_000;
const MAX_AREA_FILES = 100;
const logger = createLogger('AssessApprovalRisk');

// Kinds the model can judge by path alone: assets, docs, data, lockfiles, tests
// and fixtures. Extensions compare without case (a .PNG is an image); names
// compare with case, as toolchains do (auth_TEST.go and Contest.java are code).
const JUDGEABLE_EXTENSION =
    /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|svg|pdf|mp3|mp4|m4a|mov|webm|ogg|oga|wav|flac|woff2?|ttf|otf|eot|md|mdx|markdown|rst|adoc|txt|csv|tsv|json|jsonl|ndjson|snap)$/i;
const JUDGEABLE_NAME =
    /(?:^|\/)(?:yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock)$|(?:^|\/)(?:__tests__|__snapshots__|__fixtures__|tests?|specs?|fixtures?|testdata)\/|\.(?:test|spec)\.[^/.]+$|(?:^|\/)(?:test_[^/]+\.(?:py|go|rs)|[^/]+_test\.(?:go|py|rs)|[^/]*[a-z0-9]Tests?\.(?:cs|java))$/;

const hasDiff = (file: FileChange) =>
    typeof file.patch === 'string' && !!file.patch.trim();

/**
 * Providers omit binary and oversized patches but keep the file. The model
 * judges such a file only when its path says what it holds; any other path
 * the provider did not show, or a blank one, could hide code. Zero counters
 * cannot prove a pure rename: adapters can default missing counts to zero.
 */
export function unshownCodePath(files: FileChange[]): string | undefined {
    for (const file of files.filter((file) => !hasDiff(file))) {
        if (typeof file.filename !== 'string' || !file.filename.trim())
            return '(unnamed file)';
        const path = [file.filename, file.previous_filename]
            .filter((path): path is string => !!path?.trim())
            .find(
                (path) =>
                    !JUDGEABLE_EXTENSION.test(path) &&
                    !JUDGEABLE_NAME.test(path),
            );
        if (path) return path;
    }
    return undefined;
}

/** A provider path as inert inline code in a published reason. */
function quotedPath(path: string): string {
    let cut = path.replace(/[`\s]+/g, ' ').slice(0, 200);
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `\`${cut}\``;
}

export function buildChangeRiskDiff(files: FileChange[]): string {
    return files
        .map(
            (file) =>
                `${file.filename}${file.previous_filename && file.previous_filename !== file.filename ? ` (renamed from ${file.previous_filename})` : ''} (${file.status}; +${file.additions}/-${file.deletions})${hasDiff(file) ? `\n${file.patch}` : ''}`,
        )
        .join('\n\n');
}

/** The production risk judgment; eval runners call this same entry point. */
export async function assessChangeRisk(input: {
    organizationId: string;
    prNumber: number;
    title: string;
    body?: string;
    headSha: string;
    files: FileChange[];
    teamInstructions?: string;
    language?: string;
    areaMap?: CodeAreaRiskMap | null;
    modelSlot?: NormalizedModel;
    trace?: { baseSha: string; assessmentKey: string };
}): Promise<ChangeRiskAssessment> {
    const unshown = unshownCodePath(input.files);
    if (unshown)
        return {
            level: 'unknown',
            reason: `Kody could not read the diff of ${quotedPath(unshown)}: the Git provider did not return it.`,
            reviewedHeadSha: input.headSha,
            areaMapVersion: input.areaMap?.version,
        };
    const areaByPath = new Map(
        (input.areaMap?.files ?? []).map((area) => [area.path, area]),
    );
    const directoryByPath = new Map(
        (input.areaMap?.directories ?? []).map((area) => [area.path, area]),
    );
    const evidenceFor = (path: string) => {
        const record = areaByPath.get(path);
        const segments = path.split('/');
        const parentAreas = segments
            .slice(1)
            .map((_, index) =>
                directoryByPath.get(segments.slice(0, index + 1).join('/')),
            )
            .filter((area) => area !== undefined)
            .slice(-3)
            .map((area) => ({
                path: area.path,
                changedPrs: area.changedPrs,
                linkedBugFixPrs: area.linkedBugFixPrs,
                titleBugFixPrs: area.titleBugFixPrs,
                recentEvidence: area.recentEvidence.slice(0, 2),
            }));
        return {
            path,
            changedPrs: record?.changedPrs ?? null,
            linkedBugFixPrs: record?.linkedBugFixPrs ?? null,
            titleBugFixPrs: record?.titleBugFixPrs ?? null,
            recentEvidence: record?.recentEvidence.slice(0, 2) ?? [],
            parentAreas,
        };
    };
    const relevantAreas = input.files.map((file) => ({
        ...evidenceFor(file.filename),
        ...(file.previous_filename && file.previous_filename !== file.filename
            ? {
                  previousPath: file.previous_filename,
                  previousArea: evidenceFor(file.previous_filename),
              }
            : {}),
    }));
    const signal = (area: (typeof relevantAreas)[number]) =>
        3 * (area.linkedBugFixPrs ?? 0) +
        (area.titleBugFixPrs ?? 0) +
        Math.max(
            0,
            ...area.parentAreas.map(
                (parent) => 3 * parent.linkedBugFixPrs + parent.titleBugFixPrs,
            ),
        );
    relevantAreas.sort((a, b) => signal(b) - signal(a));
    const diff = buildChangeRiskDiff(input.files);

    try {
        const user = JSON.stringify({
            title: input.title,
            body: input.body ?? '',
            teamRiskInstructions: input.teamInstructions ?? '',
            reviewLanguage: input.language ?? 'en-US',
            fileCount: input.files.length,
            diffWasTruncated: false,
            diff,
            // Out of band: patch text is author content and could imitate a marker.
            filesWithoutDiff: input.files
                .filter((file) => !hasDiff(file))
                .map((file) => file.filename),
            historicalAreas: relevantAreas.slice(0, MAX_AREA_FILES),
            areaEvidenceTruncated: input.files.length > MAX_AREA_FILES,
            historyCoverage: input.areaMap?.coverage ?? null,
            historyWindow: input.areaMap
                ? {
                      start: input.areaMap.windowStart,
                      end: input.areaMap.windowEnd,
                      refreshedAt: input.areaMap.refreshedAt,
                  }
                : null,
        });
        const window = resolveContextWindowWithSource({
            byokMaxInputTokens: input.modelSlot?.maxInputTokens,
            modelName: getModelId(input.modelSlot),
        });
        // Only explicit limits or exact/normalized model matches can pre-reject.
        // Partial matches, routing aliases and floors stay with the provider.
        if (
            window.source === 'byok' ||
            window.source === 'litellm' ||
            window.source === 'override'
        ) {
            const promptTokens = await estimateRiskPromptTokens(
                [
                    CHANGE_RISK_PROMPT,
                    user,
                    JSON.stringify(
                        zodToStrictWireSchema(approvalRiskOutputSchema)
                            .jsonSchema,
                    ),
                ].join('\n\n'),
            );
            if (promptTokens > window.tokens) {
                return {
                    level: 'unknown',
                    reason: `The complete PR prompt needs about ${promptTokens} tokens, exceeding the configured model input limit of ${window.tokens} tokens.`,
                    failure: {
                        category: LlmErrorCategory.CONTEXT_OVERFLOW,
                        errorName: 'RiskPromptTooLargeError',
                        code: 'diff_too_large',
                    },
                    reviewedHeadSha: input.headSha,
                    areaMapVersion: input.areaMap?.version,
                };
            }
        }
        const result = await LLM.run({
            schema: approvalRiskOutputSchema,
            runName: input.trace ? 'pr-risk-assessment' : 'approval-risk',
            organizationId: input.organizationId,
            byokConfig: input.modelSlot,
            attrs: {
                ...input.trace,
                organizationId: input.organizationId,
                prNumber: input.prNumber,
                headSha: input.headSha,
                areaMapVersion: input.areaMap?.version ?? 'unavailable',
            },
            system: CHANGE_RISK_PROMPT,
            user,
        });

        if (
            !approvalRiskOutputSchema.safeParse(result).success ||
            !result?.reason?.trim()
        ) {
            throw new Error('Empty approval risk judgment');
        }
        return {
            level: result.level,
            // Bound persisted/published text after validation, preserving the judgment.
            reason:
                result.reason.trim().length > MAX_REASON_CHARS
                    ? `${result.reason.trim().slice(0, MAX_REASON_CHARS - 3)}...`
                    : result.reason.trim(),
            reviewedHeadSha: input.headSha,
            areaMapVersion: input.areaMap?.version,
        };
    } catch (error) {
        const classification =
            getClassification(error) ?? classifyLLMError(error);
        const promptTooLarge =
            classification.category === LlmErrorCategory.CONTEXT_OVERFLOW;
        logger.warn({
            message: 'Approval risk assessment failed',
            context: 'approval-risk',
            error,
            metadata: {
                organizationId: input.organizationId,
                prNumber: input.prNumber,
                headSha: input.headSha,
            },
        });
        return {
            level: 'unknown',
            failure: {
                category: classification.category,
                errorName: error instanceof Error ? error.name : 'UnknownError',
                httpStatus: classification.httpStatus,
                ...(promptTooLarge ? { code: 'diff_too_large' as const } : {}),
            },
            reason: promptTooLarge
                ? 'The complete PR prompt exceeds the configured risk model input limit.'
                : 'Kody could not assess risk for this PR.',
            reviewedHeadSha: input.headSha,
            areaMapVersion: input.areaMap?.version,
        };
    }
}
