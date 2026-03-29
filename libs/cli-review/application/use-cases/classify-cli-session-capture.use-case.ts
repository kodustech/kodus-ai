import { createLogger } from '@kodus/flow';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import {
    CliSessionClassifiedDecision,
    CliSessionDecisionOrigin,
    CliSessionDecisionType,
} from '@libs/cli-review/domain/types/cli-session-capture.types';
import { CliSessionCaptureRepository } from '@libs/cli-review/infrastructure/repositories/cli-session-capture.repository';

const LLMDecisionSchema = z.object({
    type: z.enum([
        'architectural_decision',
        'convention',
        'tradeoff',
        'implementation_detail',
        'tooling',
        'other',
    ]),
    origin: z.enum(['human', 'agent', 'collaborative']).optional(),
    decision: z.string().min(1).max(600),
    rationale: z.string().max(1000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(z.string().max(300)).max(5).optional(),
});

const LLMDecisionExtractionSchema = z.object({
    decisions: z.array(LLMDecisionSchema).max(12),
});

@Injectable()
export class ClassifyCliSessionCaptureUseCase {
    private readonly logger = createLogger(
        ClassifyCliSessionCaptureUseCase.name,
    );

    constructor(
        private readonly cliSessionCaptureRepository: CliSessionCaptureRepository,
        private readonly promptRunnerService: PromptRunnerService,
    ) {}

    async execute(captureId: string): Promise<void> {
        const capture =
            await this.cliSessionCaptureRepository.findByCaptureId(captureId);

        if (!capture) {
            this.logger.warn({
                message: 'Capture not found for classification',
                context: ClassifyCliSessionCaptureUseCase.name,
                metadata: { captureId },
            });
            return;
        }

        if (capture.event !== 'stop') {
            await this.cliSessionCaptureRepository.markSkipped(
                captureId,
                `Unsupported event: ${capture.event}`,
            );
            return;
        }

        const textParts = [
            capture.summary || '',
            capture.signals?.prompt || '',
            capture.signals?.assistantMessage || '',
        ]
            .map((part) => part.trim())
            .filter(Boolean);

        if (textParts.length === 0) {
            await this.cliSessionCaptureRepository.markSkipped(
                captureId,
                'No textual context for classification',
            );
            return;
        }

        await this.cliSessionCaptureRepository.markProcessing(captureId);

        try {
            const decisions = await this.extractWithLLM(capture);
            if (decisions.length > 0) {
                await this.cliSessionCaptureRepository.markCompleted(
                    captureId,
                    decisions,
                    'llm',
                );
                return;
            }

            const fallback = this.extractWithHeuristics(capture);
            await this.cliSessionCaptureRepository.markCompleted(
                captureId,
                fallback,
                fallback.length > 0 ? 'heuristic' : 'empty',
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'LLM classification failed for CLI session capture, using fallback',
                context: ClassifyCliSessionCaptureUseCase.name,
                metadata: {
                    captureId,
                    error: this.safeErrorMessage(error),
                },
            });

            try {
                const fallback = this.extractWithHeuristics(capture);
                await this.cliSessionCaptureRepository.markCompleted(
                    captureId,
                    fallback,
                    fallback.length > 0 ? 'heuristic-fallback' : 'empty',
                );
            } catch (fallbackError) {
                await this.cliSessionCaptureRepository.markFailed(
                    captureId,
                    this.safeErrorMessage(fallbackError),
                );
            }
        }
    }

    private async extractWithLLM(capture: {
        summary?: string;
        signals?: {
            prompt?: string;
            assistantMessage?: string;
            modifiedFiles?: string[];
            toolUses?: Array<{
                tool: string;
                filePath?: string;
                summary?: string;
            }>;
        };
    }): Promise<CliSessionClassifiedDecision[]> {
        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            LLMModelProvider.CEREBRAS_GLM_47,
            LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
        );

        const prompt = [
            'You are classifying coding session captures into reusable decisions.',
            '',
            'Return ONLY JSON with shape:',
            '{ "decisions": [ { "type": "...", "origin": "...", "decision": "...", "rationale": "...", "confidence": 0.0, "evidence": ["..."] } ] }',
            '',
            'Allowed decision types:',
            '- architectural_decision: high-level structure or system choice',
            '- convention: team style/naming/process convention',
            '- tradeoff: explicit compromise between options',
            '- implementation_detail: concrete technical implementation choice',
            '- tooling: tool or framework choice',
            '- other: valid but uncategorized decision',
            '',
            'Rules:',
            '- Extract only concrete choices, not generic statements.',
            '- Keep each "decision" concise and self-contained.',
            '- confidence must be between 0 and 1.',
            '',
            'Allowed origin values:',
            '- human: the human explicitly requested or decided this',
            '- agent: the agent proposed and implemented this without the human asking',
            '- collaborative: the agent suggested and the human confirmed/refined',
            '',
            '- If nothing useful exists, return { "decisions": [] }.',
        ].join('\n');

        const userPayload = {
            summary: capture.summary || '',
            prompt: capture.signals?.prompt || '',
            assistantMessage: capture.signals?.assistantMessage || '',
            modifiedFiles: capture.signals?.modifiedFiles || [],
            toolUses: capture.signals?.toolUses || [],
        };

        const result = await promptRunner
            .builder()
            .setParser(ParserType.ZOD, LLMDecisionExtractionSchema)
            .setLLMJsonMode(true)
            .setTemperature(0)
            .setPayload(userPayload)
            .addPrompt({
                role: PromptRole.SYSTEM,
                prompt,
            })
            .addPrompt({
                role: PromptRole.USER,
                prompt: JSON.stringify(userPayload),
            })
            .setRunName('classifyCliSessionCapture')
            .execute();

        const rawDecisions = result?.decisions ?? [];
        return rawDecisions.map((decision) => {
            const normalizedConfidence = this.normalizeConfidence(
                decision.confidence,
            );
            const normalizedType = decision.type as CliSessionDecisionType;
            const origin = decision.origin as CliSessionDecisionOrigin;

            return {
                type: normalizedType,
                origin,
                decision: this.trim(decision.decision, 500),
                rationale: decision.rationale
                    ? this.trim(decision.rationale, 1000)
                    : undefined,
                confidence: normalizedConfidence,
                evidence: (decision.evidence || [])
                    .map((item) => this.trim(item, 300))
                    .filter(Boolean)
                    .slice(0, 5),
                autoPromoteCandidate: this.shouldAutoPromote(
                    normalizedType,
                    normalizedConfidence,
                ),
            };
        });
    }

    private extractWithHeuristics(capture: {
        summary?: string;
        signals?: {
            prompt?: string;
            assistantMessage?: string;
            modifiedFiles?: string[];
            toolUses?: Array<{ tool: string; filePath?: string }>;
        };
    }): CliSessionClassifiedDecision[] {
        const sourceText = [
            capture.summary || '',
            capture.signals?.prompt || '',
            capture.signals?.assistantMessage || '',
        ]
            .filter(Boolean)
            .join('\n');

        if (!sourceText) {
            return [];
        }

        const sentences = sourceText
            .split(/\n+|(?<=[.!?])\s+/g)
            .map((sentence) => sentence.trim())
            .filter(Boolean)
            .slice(0, 80);

        const candidateSentences = sentences.filter((sentence) =>
            /(decid|because|trade[- ]?off|prefer|chose|choose|adopt|use|convention|pattern|standard)/i.test(
                sentence,
            ),
        );

        const selected =
            candidateSentences.length > 0
                ? candidateSentences.slice(0, 8)
                : sentences.slice(0, 3);

        const evidence = (capture.signals?.modifiedFiles || []).slice(0, 3);

        return selected.map((sentence) => {
            const type = this.inferDecisionType(sentence);
            const confidence = candidateSentences.length > 0 ? 0.35 : 0.2;

            return {
                type,
                decision: this.trim(sentence, 500),
                confidence,
                evidence,
                autoPromoteCandidate: this.shouldAutoPromote(type, confidence),
            };
        });
    }

    private inferDecisionType(text: string): CliSessionDecisionType {
        const value = text.toLowerCase();

        if (
            /(architecture|architectural|layer|module|schema|database|queue|event|service boundary|system design)/.test(
                value,
            )
        ) {
            return 'architectural_decision';
        }

        if (
            /(convention|style|naming|format|lint|folder structure)/.test(value)
        ) {
            return 'convention';
        }

        if (/(trade[- ]?off|versus|vs\.|instead of|however|but)/.test(value)) {
            return 'tradeoff';
        }

        if (
            /(tool|framework|library|package|cursor|codex|claude|cli|sdk|dependency)/.test(
                value,
            )
        ) {
            return 'tooling';
        }

        if (
            /(implement|refactor|validation|jwt|cache|middleware|repository|endpoint|handler)/.test(
                value,
            )
        ) {
            return 'implementation_detail';
        }

        return 'other';
    }

    private shouldAutoPromote(
        type: CliSessionDecisionType,
        confidence?: number,
    ): boolean {
        if (typeof confidence !== 'number') {
            return false;
        }

        return (
            confidence >= 0.7 &&
            ['architectural_decision', 'convention', 'tradeoff'].includes(type)
        );
    }

    private normalizeConfidence(value?: number): number | undefined {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return undefined;
        }

        return Math.max(0, Math.min(1, value));
    }

    private trim(value: string, maxLength: number): string {
        if (!value) {
            return value;
        }

        return value.length <= maxLength
            ? value
            : `${value.slice(0, maxLength - 3)}...`;
    }

    private safeErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return 'Unknown error';
    }
}
