import { Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { generateObject } from 'ai';
import { z } from 'zod';
import { byokToVercelModel } from '@libs/llm/byok-to-vercel';
import type { IPublicPrGroupingService } from '@libs/cli-review/domain/contracts/public-pr-grouping.service.contract';
import type { PublicPrMetadata } from './github-public-pr.service';

const GROUPING_MODEL = 'gemini-3-flash-preview';
const MAX_DIFF_CHARS = 80_000;
// Gemini 3 Flash burns most of the output budget on internal
// "thinking" tokens, so we both disable thinking (this task doesn't
// need it) and leave a generous ceiling so the JSON object always
// closes — running into MAX_TOKENS truncates mid-string and AI_SDK
// returns AI_NoObjectGeneratedError → groupings: undefined → UI
// falls back to the tree.
const MAX_OUTPUT_TOKENS = 4000;

const GroupingSchema = z.object({
    groups: z
        .array(
            z.object({
                title: z
                    .string()
                    .describe(
                        'A short descriptive title (3–7 words) for what this group does.',
                    ),
                explanation: z
                    .string()
                    .describe(
                        'One sentence explaining the change in plain English. No file names.',
                    ),
                files: z
                    .array(z.string())
                    .describe(
                        'Full file paths belonging to this group, copied verbatim from the diff.',
                    ),
            }),
        )
        .min(1)
        .max(8)
        .describe(
            'Logical groupings of the PR files by intent. Each file appears in exactly one group.',
        ),
});

export type PublicPrGrouping = {
    title: string;
    explanation: string;
    files: string[];
};

/**
 * Generates a Devin-Review-style grouping of the PR files: instead of
 * listing them flat by folder, the LLM clusters them by what they do
 * (e.g. "ToolReference: Struct → Enum") and writes a one-line
 * explanation per group. Used by the demo sidebar to surface PR intent
 * before the reviewer opens any individual file.
 *
 * Runs in parallel with the AI summary at enqueue time. Failure here
 * is non-blocking — the sidebar falls back to the tree view.
 */
@Injectable()
export class PublicPrGroupingService implements IPublicPrGroupingService {
    private readonly logger = createLogger(PublicPrGroupingService.name);

    async generate(
        pr: PublicPrMetadata,
        diff: string,
        changedFiles: string[],
    ): Promise<PublicPrGrouping[] | undefined> {
        if (changedFiles.length === 0) return undefined;
        // A 1-file PR has no grouping to do — the tree view is enough.
        if (changedFiles.length < 2) return undefined;

        try {
            const model = byokToVercelModel(
                undefined,
                'main',
                {},
                GROUPING_MODEL,
            );
            const truncated = diff.length > MAX_DIFF_CHARS;

            const { object } = await generateObject({
                model,
                schema: GroupingSchema,
                temperature: 0.15,
                maxOutputTokens: MAX_OUTPUT_TOKENS,
                // Cluster-by-intent is a shape-matching task, not a
                // reasoning task — turning thinking off gives all of
                // the output budget to the actual JSON and shaves
                // ~4–8s off the call.
                providerOptions: {
                    google: {
                        thinkingConfig: { thinkingBudget: 0 },
                    },
                },
                prompt: buildPrompt(
                    pr,
                    diff.slice(0, MAX_DIFF_CHARS),
                    changedFiles,
                    truncated,
                ),
            });

            // Trust the LLM but defend against hallucinated file paths
            // — drop anything that wasn't in the PR. If a real file
            // ends up unassigned (rare), fall back by attaching it to
            // a synthetic "Other changes" group at the end.
            const valid = new Set(changedFiles);
            const seen = new Set<string>();
            const groups: PublicPrGrouping[] = [];
            for (const g of object.groups) {
                const files = g.files.filter(
                    (f) => valid.has(f) && !seen.has(f),
                );
                files.forEach((f) => seen.add(f));
                if (files.length === 0) continue;
                groups.push({
                    title: g.title.trim(),
                    explanation: g.explanation.trim(),
                    files,
                });
            }

            const leftovers = changedFiles.filter((f) => !seen.has(f));
            if (leftovers.length > 0) {
                groups.push({
                    title: 'Other changes',
                    explanation:
                        'Smaller follow-ups that don\'t cluster with the rest.',
                    files: leftovers,
                });
            }

            return groups.length > 0 ? groups : undefined;
        } catch (err) {
            this.logger.warn({
                message: 'Failed to generate file groupings for public PR',
                context: PublicPrGroupingService.name,
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
    files: string[],
    truncated: boolean,
): string {
    return [
        `You are analyzing a GitHub pull request and grouping its files into "logical change clusters" by intent — what the change does, not which directory it lives in.`,
        ``,
        `Pull request: ${pr.owner}/${pr.repo}#${pr.prNumber}`,
        `Title: ${pr.title}`,
        `Branches: ${pr.baseRef} ← ${pr.headRef}`,
        `Files changed (${files.length}):`,
        ...files.map((f) => `- ${f}`),
        ``,
        `Rules:`,
        `- Produce 2–6 groups when the PR is non-trivial.`,
        `- Each file appears in exactly one group.`,
        `- "title" should describe what changed, like "ToolReference: Struct → Enum" or "Harmony Router: tool_choice constraint generation". Not the folder name.`,
        `- "explanation" is one sentence in plain English; mention the mechanism, not file names.`,
        `- Use the EXACT file paths from the list above in "files" — don't paraphrase.`,
        `- If everything is one logical change, return a single group covering all files.`,
        ``,
        truncated
            ? `Note: the diff was truncated to the first ~80k characters. Focus on what you can see.`
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
