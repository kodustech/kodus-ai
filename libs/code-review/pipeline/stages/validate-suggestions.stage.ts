import { createLogger } from '@kodus/flow';
import {
    SUPPORTED_LANGUAGES,
    ValidationCandidate,
} from '@libs/code-review/domain/types/astValidate.type';
import { PlatformType } from '@libs/core/domain/enums';
import {
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { applyEdit } from '@morphllm/morphsdk';
import { Injectable } from '@nestjs/common';
import { parsePatch } from 'diff';
import pLimit from 'p-limit';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { estimateTokens } from '@libs/code-review/infrastructure/adapters/services/utils/token-estimator';
import { SandboxSyntaxValidator } from '@libs/code-review/infrastructure/adapters/services/sandboxSyntaxValidator.service';
import { SuggestionLLMValidator } from '@libs/code-review/infrastructure/adapters/services/suggestionLLMValidator.service';

@Injectable()
export class ValidateSuggestionsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName: string = 'ValidateSuggestionsStage';
    readonly errorSeverity = 'partial' as const;
    private readonly logger = createLogger(ValidateSuggestionsStage.name);

    private readonly CONCURRENCY_LIMIT = 10;
    private readonly MAX_LINES_THRESHOLD = 15;
    private readonly MAX_CHARS_THRESHOLD = 1000;

    constructor(
        private readonly sandboxSyntaxValidator: SandboxSyntaxValidator,
        private readonly suggestionLLMValidator: SuggestionLLMValidator,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        try {
            if (!(await this.shouldRunStage(context))) return context;

            const {
                validSuggestions,
                changedFiles,
                organizationAndTeamData,
                pullRequest,
            } = context;
            const prNumber = pullRequest.number;

            const filtered = await this.filterSuggestions(
                validSuggestions,
                context,
            );

            if (filtered.length === 0) {
                this.logGeneral(
                    'All suggestions filtered out as too complex/long/incompatible',
                    {
                        organizationAndTeamData,
                        prNumber,
                    },
                );

                return context;
            }

            const maxInputTokens =
                context.codeReviewConfig?.byokConfig?.main?.maxInputTokens;

            const candidates = await this.prepareValidationCandidates(
                filtered,
                changedFiles,
                maxInputTokens,
            );

            if (candidates.length === 0) {
                this.logGeneral('No patched files generated for validation', {
                    validSuggestions,
                    changedFiles,
                    organizationAndTeamData,
                    prNumber,
                });

                return context;
            }

            const validIds = await this.performFullValidation(
                candidates,
                organizationAndTeamData,
                prNumber,
            );

            const updatedSuggestions = this.mapValidationResults(
                validSuggestions,
                candidates,
                validIds,
            );

            return this.updateContext(context, (draft) => {
                draft.validSuggestions = updatedSuggestions;
            });
        } catch (error) {
            const { organizationAndTeamData, pullRequest } = context;
            this.logError('Error during validation process', error, {
                organizationAndTeamData,
                prNumber: pullRequest.number,
            });

            throw new Error(
                StageMessageHelper.error(
                    PipelineReasons.SUGGESTIONS.VALIDATION_FAILED.message,
                    error,
                ),
                { cause: error },
            );
        }
    }

    private async shouldRunStage(context: CodeReviewPipelineContext) {
        const {
            organizationAndTeamData,
            pullRequest,
            platformType,
            codeReviewConfig,
            validSuggestions,
            changedFiles,
        } = context;

        const prNumber = pullRequest.number;

        if (!codeReviewConfig?.enableCommittableSuggestions) {
            this.logGeneral(
                'Committable suggestions feature is disabled in the configuration',
                {
                    organizationAndTeamData,
                    prNumber,
                },
            );

            return false;
        }

        if (platformType !== PlatformType.GITHUB) {
            this.logGeneral(
                'Skipping validation stage for non-GitHub platform',

                {
                    platformType,
                    prNumber,
                    organizationAndTeamData,
                },
            );

            return false;
        }

        if (!validSuggestions?.length || !changedFiles?.length) {
            this.logGeneral(
                'No valid suggestions or changed files to validate',

                {
                    organizationAndTeamData,
                    prNumber,
                    validSuggestionsCount: validSuggestions?.length || 0,
                    changedFilesCount: changedFiles?.length || 0,
                },
            );

            return false;
        }

        return true;
    }

    private async performFullValidation(
        candidates: ValidationCandidate[],
        orgData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<Set<string>> {
        // Step 1: Syntax validation via kodus-graph parse in a dedicated sandbox
        const syntaxValidIds =
            await this.sandboxSyntaxValidator.validateFiles(candidates);

        const syntaxValidCandidates = candidates.filter((c) =>
            syntaxValidIds.has(c.id),
        );

        // Step 2: LLM validation for syntax-valid candidates
        const limit = pLimit(this.CONCURRENCY_LIMIT);

        const llmValidations = syntaxValidCandidates.map((candidate) =>
            limit(async () => {
                const isValid = await this.validateWithLLM(
                    candidate,
                    orgData,
                    prNumber,
                );
                return isValid ? candidate.id : null;
            }),
        );

        const llmResults = await Promise.allSettled(llmValidations);
        const validIds = llmResults
            .map((res) => (res.status === 'fulfilled' ? res.value : null))
            .filter((id): id is string => id !== null);

        return new Set(validIds);
    }

    private async validateWithLLM(
        candidate: ValidationCandidate,
        orgData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<boolean> {
        try {
            const code = Buffer.from(candidate.encodedData, 'base64').toString(
                'utf-8',
            );
            const res = await this.suggestionLLMValidator.validateWithLLM(
                {
                    code,
                    filePath: candidate.filePath,
                    diff: candidate.diff,
                    language: candidate.language,
                },
                orgData,
                prNumber,
            );
            return !!res?.isValid;
        } catch (error) {
            this.logError('LLM validation error', error, { id: candidate.id });
            return false;
        }
    }

    private mapValidationResults(
        originalSuggestions: Partial<CodeSuggestion>[],
        candidates: ValidationCandidate[],
        validIds: Set<string>,
    ): Partial<CodeSuggestion>[] {
        const candidateMap = new Map(candidates.map((c) => [c.id, c]));

        return originalSuggestions.map((suggestion) => {
            if (!suggestion.id || !validIds.has(suggestion.id))
                return suggestion;

            const candidate = candidateMap.get(suggestion.id);
            if (!candidate) return suggestion;

            return {
                ...suggestion,
                isCommittable: true,
                validatedData: {
                    code: candidate.suggestion,
                    diff: candidate.diff,
                    lineStart: candidate.newLineStart,
                    lineEnd: candidate.newLineEnd,
                },
            };
        });
    }

    private getFormattedSuggestionFromDiff(diff: string): {
        code: string;
        startLine: number;
        endLine: number;
    } | null {
        const parsedDiff = parsePatch(diff);

        if (parsedDiff.length !== 1) {
            this.logWarn(
                'Suggestion diff affects multiple files, marking as complex.',

                { diff },
            );

            return null;
        }

        const fileDiff = parsedDiff[0];

        if (fileDiff.hunks.length !== 1) {
            this.logWarn(
                'Suggestion contains multiple hunks, marking as complex.',
                { diff },
            );

            return null;
        }

        const hunk = fileDiff.hunks[0];

        if (hunk.lines.length > this.MAX_LINES_THRESHOLD) {
            this.logWarn(
                'Suggestion hunk exceeds maximum line threshold, marking as complex.',
                {
                    linesCount: hunk.lines.length,
                    diff,
                },
            );

            return null;
        }

        const charCount = hunk.lines.reduce(
            (acc, line) => acc + line.trim().length,
            0,
        );

        if (charCount > this.MAX_CHARS_THRESHOLD) {
            this.logWarn(
                'Suggestion hunk exceeds maximum character threshold, marking as complex.',
                {
                    charCount: hunk.lines.reduce(
                        (acc, line) => acc + line.length,
                        0,
                    ),
                    diff,
                },
            );

            return null;
        }

        const suggestionLines: string[] = [];

        let currentLineNum = hunk.oldStart;
        let firstAddedLineNum: number | null = null;
        let lastAddedLineNum: number | null = null;

        for (const line of hunk.lines) {
            const indicator = line[0];

            if (indicator === '+') {
                if (!line.startsWith('+++')) {
                    suggestionLines.push(line.slice(1));
                }
            } else if (indicator === '-') {
                if (firstAddedLineNum === null) {
                    firstAddedLineNum = currentLineNum;
                }

                lastAddedLineNum = currentLineNum;

                currentLineNum++;
            } else if (indicator !== '\\') {
                currentLineNum++;
            }
        }

        if (firstAddedLineNum === null || lastAddedLineNum === null) {
            this.logWarn(
                'No added lines found in suggestion hunk, marking as complex.',
                { diff },
            );

            return null;
        }

        return {
            code: suggestionLines.join('\n'),
            startLine: firstAddedLineNum,
            endLine: lastAddedLineNum,
        };
    }

    private async filterSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        context: CodeReviewPipelineContext,
    ): Promise<Partial<CodeSuggestion>[]> {
        const limit = pLimit(this.CONCURRENCY_LIMIT);

        const tasks = suggestions.map((suggestion) =>
            limit(async () => {
                const filePath = suggestion.relevantFile;
                const code = suggestion.improvedCode || '';
                const lines = code.split('\n').length;
                const chars = code.length;

                // Language Support Check
                if (!filePath || !this.isLanguageSupported(filePath)) {
                    // Unsupported language — can't validate, post as normal comment
                    this.logger.log({
                        message: `Suggestion ${suggestion.id} has unsupported language (${filePath}), posting as normal comment`,
                        context: this.stageName,
                    });
                    return {
                        ...suggestion,
                        isCommittable: false,
                        validatedData: undefined,
                    };
                }

                // Threshold Check
                if (
                    chars >= this.MAX_CHARS_THRESHOLD ||
                    lines >= this.MAX_LINES_THRESHOLD
                ) {
                    // Code too large to validate — post as normal comment
                    this.logger.log({
                        message: `Suggestion ${suggestion.id} exceeds threshold (${lines} lines, ${chars} chars), posting as normal comment`,
                        context: this.stageName,
                    });
                    return {
                        ...suggestion,
                        isCommittable: false,
                        validatedData: undefined,
                    };
                }

                // AST Simplicity Check
                try {
                    const { isSimple, reason } =
                        await this.suggestionLLMValidator.checkSuggestionSimplicity(
                            context.organizationAndTeamData,
                            context.pullRequest.number,
                            suggestion,
                        );

                    if (isSimple) return suggestion;

                    // Morph/committable failed — fall back to non-committable suggestion
                    // instead of discarding entirely. The suggestion is still valid,
                    // it just won't have the "Apply" button on GitHub.
                    this.logger.log({
                        message: `Suggestion ${suggestion.id} is not committable (${reason}), posting as normal comment`,
                        context: this.stageName,
                    });
                    return {
                        ...suggestion,
                        isCommittable: false,
                        validatedData: undefined,
                    };
                } catch (error) {
                    this.logger.warn({
                        message: `Error during simplicity check for ${suggestion.id}, posting as normal comment`,
                        context: this.stageName,
                        error,
                    });

                    return {
                        ...suggestion,
                        isCommittable: false,
                        validatedData: undefined,
                    };
                }
            }),
        );

        const results = await Promise.allSettled(tasks);
        return results
            .filter(
                (
                    r,
                ): r is PromiseFulfilledResult<Partial<CodeSuggestion> | null> =>
                    r.status === 'fulfilled',
            )
            .map((r) => r.value)
            .filter((s): s is Partial<CodeSuggestion> => !!s);
    }

    private async prepareValidationCandidates(
        suggestions: Partial<CodeSuggestion>[],
        files: FileChange[],
        maxInputTokens?: number,
    ): Promise<ValidationCandidate[]> {
        const limit = pLimit(this.CONCURRENCY_LIMIT);
        const grouped = this.groupSuggestionsByFile(suggestions, files);
        const tasks: Promise<ValidationCandidate | null>[] = [];

        for (const [filePath, { fileData, suggestions }] of Object.entries(
            grouped,
        )) {
            if (!this.isLanguageSupported(filePath) || !fileData?.fileContent)
                continue;

            // If maxInputTokens is configured and the file content exceeds
            // the budget, skip committable suggestions for this file.
            // Committable suggestions require the full file content and
            // cannot work with chunked content.
            if (maxInputTokens && maxInputTokens > 0) {
                const fileTokens = estimateTokens(fileData.fileContent);
                const effectiveBudget = Math.floor(maxInputTokens * 0.95);
                if (fileTokens > effectiveBudget) {
                    this.logGeneral(
                        `Skipping committable suggestions for ${filePath}: file content (${fileTokens} tokens) exceeds maxInputTokens budget (${effectiveBudget} tokens)`,
                        { filePath, fileTokens, effectiveBudget },
                    );
                    continue;
                }
            }

            for (const suggestion of suggestions) {
                tasks.push(
                    limit(async () =>
                        this.applySingleEdit(
                            suggestion,
                            filePath,
                            fileData.fileContent,
                        ),
                    ),
                );
            }
        }

        const results = await Promise.allSettled(tasks);
        return results
            .filter(
                (r): r is PromiseFulfilledResult<ValidationCandidate | null> =>
                    r.status === 'fulfilled',
            )
            .map((r) => r.value)
            .filter((v): v is ValidationCandidate => !!v);
    }

    private async applySingleEdit(
        suggestion: Partial<CodeSuggestion>,
        filePath: string,
        originalCode: string,
    ): Promise<ValidationCandidate | null> {
        if (!suggestion.id || !suggestion.improvedCode || !suggestion.llmPrompt)
            return null;

        try {
            const result = await applyEdit(
                {
                    originalCode,
                    codeEdit: suggestion.improvedCode,
                    instruction: suggestion.llmPrompt,
                    filepath: filePath,
                },
                { morphApiKey: process.env.API_MORPHLLM_API_KEY },
            );

            if (!result?.mergedCode) return null;

            const formatted = this.getFormattedSuggestionFromDiff(result.udiff);
            if (!formatted) return null;

            return {
                id: suggestion.id,
                filePath,
                encodedData: Buffer.from(result.mergedCode).toString('base64'),
                diff: result.udiff,
                suggestion: formatted.code,
                newLineStart: formatted.startLine,
                newLineEnd: formatted.endLine,
            };
        } catch (error) {
            this.logError('Failed to apply single edit', error, {
                suggestionId: suggestion.id,
                filePath,
            });

            return null;
        }
    }

    private isLanguageSupported(filename: string): boolean {
        const extension = filename.slice(filename.lastIndexOf('.'));
        return Object.values(SUPPORTED_LANGUAGES).some((lang) =>
            lang.extensions.includes(extension),
        );
    }

    private groupSuggestionsByFile(
        suggestions: Partial<CodeSuggestion>[],
        files: FileChange[],
    ) {
        const filesMap = new Map(files.map((file) => [file.filename, file]));
        return suggestions.reduce<{
            [path: string]: {
                fileData: FileChange;
                suggestions: Partial<CodeSuggestion>[];
            };
        }>((acc, suggestion) => {
            const path = suggestion.relevantFile!;
            if (!acc[path]) {
                const fileData = filesMap.get(path);
                if (fileData) acc[path] = { fileData, suggestions: [] };
            }
            if (acc[path]) acc[path].suggestions.push(suggestion);
            return acc;
        }, {});
    }

    private logDiscard(
        id: string | undefined,
        reason: string,
        meta: object,
        context: CodeReviewPipelineContext,
    ) {
        this.logger.log({
            message: `Discarding suggestion: ${reason}`,
            context: this.stageName,
            metadata: {
                suggestionId: id,
                pr: context.pullRequest.number,
                ...meta,
            },
        });
    }

    private logGeneral(message: string, metadata: object) {
        this.logger.log({ message, context: this.stageName, metadata });
    }

    private logWarn(message: string, metadata: object) {
        this.logger.warn({ message, context: this.stageName, metadata });
    }

    private logError(message: string, error: any, metadata: object) {
        this.logger.error({
            message,
            context: this.stageName,
            error,
            metadata,
        });
    }
}
