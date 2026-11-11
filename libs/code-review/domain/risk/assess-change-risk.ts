import { z } from 'zod';

import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { CodeAreaRiskMap } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import {
    classifyLLMError,
    getClassification,
} from '@libs/llm/error-classifier';
import { createLogger } from '@libs/core/log/logger';
import { CHANGE_RISK_PROMPT } from './change-risk-prompt';
import { addedCodeLines } from './added-code-lines';

/** Internal judgment retained for compatibility; public PR risk is binary. */
export interface ChangeRiskAssessment {
    level: 'low' | 'medium' | 'high' | 'unknown';
    reason: string;
    reviewedHeadSha: string;
    areaMapVersion?: string;
    failure?: { category: string; errorName: string; httpStatus?: number };
}

export const approvalRiskOutputSchema = z.object({
    level: z.enum(['low', 'medium', 'high']),
    // Length alone must not discard a valid risk judgment.
    reason: z.string().min(8),
});

const MAX_DIFF_CHARS = 50_000;
const MAX_REASON_CHARS = 2_000;
const MAX_AREA_FILES = 100;
const logger = createLogger('AssessApprovalRisk');
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|py|go|java|cs|rs)$/i;
const TEST_FILE =
    /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|\.|$)|\.(?:test|spec)\.[^/.]+$|(?:^|\/)(?:test_[^/]+\.(?:py|go|rs)|[^/]+_test\.(?:go|py|rs)|[^/]+Tests?\.(?:cs|java))$/i;
const ADDED_CONTROL_FLOW = /\b(?:if\s*\(|return\b|throw\b)/;
// Parentheses may follow newlines or comments that only the lexer can mask.
const POSSIBLE_ADDED_CONTROL_FLOW = /\b(?:if|return|throw)\b/;

function controlFlowEvidence(
    files: FileChange[],
): 'none' | 'untested' | 'unverifiable' {
    if (
        files.some(
            (file) =>
                file.status !== 'removed' &&
                TEST_FILE.test(file.filename) &&
                /\S/.test(
                    addedCodeLines(file.patch ?? '', file.filename) ?? '',
                ),
        )
    )
        return 'none';
    let unverifiable = false;
    for (const file of files) {
        if (
            file.status === 'removed' ||
            !SOURCE_FILE.test(file.filename) ||
            TEST_FILE.test(file.filename)
        )
            continue;
        const code = addedCodeLines(
            file.patch ?? '',
            file.filename,
            POSSIBLE_ADDED_CONTROL_FLOW,
        );
        if (code === undefined) unverifiable = true;
        else if (ADDED_CONTROL_FLOW.test(code)) return 'untested';
    }
    return unverifiable ? 'unverifiable' : 'none';
}

export function buildChangeRiskDiff(files: FileChange[]): string {
    return files
        .map(
            (file) =>
                `${file.filename}${file.previous_filename && file.previous_filename !== file.filename ? ` (renamed from ${file.previous_filename})` : ''} (${file.status}; +${file.additions}/-${file.deletions})\n${file.patch ?? '[patch unavailable]'}`,
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
    const diffWasTruncated = diff.length > MAX_DIFF_CHARS;

    try {
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
            user: JSON.stringify({
                title: input.title,
                body: input.body ?? '',
                teamRiskInstructions: input.teamInstructions ?? '',
                reviewLanguage: input.language ?? 'en-US',
                fileCount: input.files.length,
                diffWasTruncated,
                diff: diff.slice(0, MAX_DIFF_CHARS),
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
            }),
        });

        if (
            !approvalRiskOutputSchema.safeParse(result).success ||
            !result?.reason?.trim()
        ) {
            throw new Error('Empty approval risk judgment');
        }
        const flow =
            result.level === 'low' ? controlFlowEvidence(input.files) : 'none';
        if (flow === 'unverifiable')
            return {
                level: 'unknown',
                reason: 'Kody could not verify control-flow and test evidence in this diff.',
                reviewedHeadSha: input.headSha,
                areaMapVersion: input.areaMap?.version,
            };
        if (flow === 'untested') {
            return {
                level: 'medium',
                reason: input.language?.toLowerCase().startsWith('pt')
                    ? 'O fluxo do código mudou sem evidência de testes no PR; uma pessoa deve conferir o comportamento.'
                    : 'Control flow changed without test evidence in this PR; a person should verify the behavior.',
                reviewedHeadSha: input.headSha,
                areaMapVersion: input.areaMap?.version,
            };
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
            },
            reason: 'Kody could not assess risk for this PR.',
            reviewedHeadSha: input.headSha,
            areaMapVersion: input.areaMap?.version,
        };
    }
}
