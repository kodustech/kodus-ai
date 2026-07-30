import { Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { generateText } from 'ai';
import { byokToVercelModel } from '@libs/llm/byok-to-vercel';
import type { IPublicPrAiSummaryService } from '@libs/cli-review/domain/contracts/public-pr-ai-summary.service.contract';
import type { PublicPrMetadata } from './github-public-pr.service';

const SUMMARY_MODEL = 'gemini-3-flash-preview';
const MAX_DIFF_CHARS = 60_000;
const MAX_OUTPUT_TOKENS = 600;

/**
 * Generates a short Devin-Review-style "AI analysis" of a public PR
 * — a one-line intro plus 3–5 bullets of key changes. Lives in the
 * Description tab of the demo so the visitor sees an instant feel for
 * what the PR is about, not just the GitHub title.
 *
 * Runs in parallel with the actual review pipeline so it doesn't add
 * latency to the diff/suggestions flow.
 */
@Injectable()
export class PublicPrAiSummaryService implements IPublicPrAiSummaryService {
    private readonly logger = createLogger(PublicPrAiSummaryService.name);

    async generate(
        pr: PublicPrMetadata,
        diff: string,
    ): Promise<string | undefined> {
        try {
            const model = byokToVercelModel(
                undefined,
                'main',
                {},
                SUMMARY_MODEL,
            );

            const truncatedDiff = diff.slice(0, MAX_DIFF_CHARS);
            const truncated = diff.length > MAX_DIFF_CHARS;

            const prompt = buildPrompt(pr, truncatedDiff, truncated);

            const { text } = await generateText({
                model,
                prompt,
                temperature: 0.2,
                maxOutputTokens: MAX_OUTPUT_TOKENS,
            });

            return text.trim() || undefined;
        } catch (err) {
            this.logger.warn({
                message: 'Failed to generate AI summary for public PR',
                context: PublicPrAiSummaryService.name,
                error: err,
                metadata: {
                    repo: `${pr.owner}/${pr.repo}`,
                    pr: pr.prNumber,
                },
            });
            return undefined;
        }
    }
}

function buildPrompt(
    pr: PublicPrMetadata,
    diff: string,
    truncated: boolean,
): string {
    return [
        `You are reviewing a GitHub pull request. Write a concise summary for someone who hasn't read the PR yet.`,
        ``,
        `Pull request: ${pr.owner}/${pr.repo}#${pr.prNumber}`,
        `Title: ${pr.title}`,
        pr.author ? `Author: ${pr.author.login}` : '',
        `Branches: ${pr.baseRef} ← ${pr.headRef}`,
        `Files changed: ${pr.changedFiles} (+${pr.additions} −${pr.deletions})`,
        '',
        `Output format (markdown, no preamble, keep tight):`,
        ``,
        `One short paragraph (1–3 sentences) describing what the PR does in plain English. Mention the core mechanism, not file names.`,
        ``,
        `**Key changes:**`,
        ``,
        `- 3 to 5 bullets, each starts with a verb in past tense (Added/Refactored/Fixed/…).`,
        `- Each bullet names the concrete thing changed and *why* it matters. Reference the most relevant file path inline as backticks when useful.`,
        `- No marketing fluff, no "this PR" / "this change" filler.`,
        ``,
        truncated
            ? `Note: the diff is large — only the first ~60k characters are shown. Focus on what you can see.`
            : '',
        '',
        `Unified diff:`,
        '```diff',
        diff,
        '```',
    ]
        .filter(Boolean)
        .join('\n');
}
