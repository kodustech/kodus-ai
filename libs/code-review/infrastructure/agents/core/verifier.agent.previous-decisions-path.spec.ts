/**
 * Issue #2020 — the verifier loses the PR's previous decisions when the finder
 * names the file by its basename.
 *
 * Production (#2011, round B, 2026-09-25 17:58 UTC): two candidates on the same
 * lines of libs/common/utils/prompts/replyAddressedToKody.ts. The one whose
 * `relevantFile` was the full path got <PreviousReviewDecisions>; the one whose
 * `relevantFile` was "replyAddressedToKody.ts" got none, and its verifier wrote
 * "no PreviousReviewDecisions evidence was provided to invoke the
 * implemented-decision exception". The comment is later anchored to the full
 * path (delivery resolves the file), so the reader sees the same file — only
 * the verifier was told nothing was ever decided there.
 */
import type {
    AgentRunner,
    AgentSpec,
    AgentRunInput,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import {
    verifierPromptFor,
    LlmVerifier,
} from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';

const FULL = 'libs/common/utils/prompts/replyAddressedToKody.ts';

const decision: PrDecisionRecord = {
    suggestionId: 'round-a',
    relevantFile: FULL,
    relevantLinesStart: 166,
    relevantLinesEnd: 167,
    suggestionContent: 'Decode both reference kinds in a single pass.',
    label: 'bug',
    outcome: 'implemented',
    decidedAt: '2026-09-25T17:20:25.731Z',
};

function capturingRunner(prompts: string[]): AgentRunner {
    return {
        async run(_spec: AgentSpec, input: AgentRunInput): Promise<RunState> {
            prompts.push(String(input.prompt));
            return {
                runId: 'r',
                agentId: 'verifier',
                status: 'completed',
                steps: [],
                artifacts: [
                    {
                        type: 'submitVerdict',
                        payload: { keep: true, rationale: 'x' },
                    },
                ],
                usage: {},
                trace: [],
            } as unknown as RunState;
        },
    } as AgentRunner;
}

async function promptFor(
    relevantFile: string,
    extra: Record<string, unknown> = {},
    decisions = [decision],
): Promise<string> {
    const prompts: string[] = [];
    const verifier = new LlmVerifier(capturingRunner(prompts), {
        modelId: 'mock',
        tools: new InMemoryToolRegistry([]),
        previousDecisions: decisions,
    });
    await verifier.verify(
        {
            relevantFile,
            relevantLinesStart: 124,
            relevantLinesEnd: 133,
            suggestionContent: 'single-pass decode leaves &lt; un-neutralized',
            existingCode: 'x',
            improvedCode: 'y',
            ...extra,
        } as any,
        { runId: 't' },
    );
    return prompts[0];
}

describe('#2020 — previous decisions reach the verifier whatever spelling the finder used for the file', () => {
    it('control: full path gets the decision', async () => {
        expect(await promptFor(FULL)).toContain('<PreviousReviewDecisions>');
    });

    it('basename of a changed file gets the decision too', async () => {
        expect(await promptFor('replyAddressedToKody.ts')).toContain(
            '<PreviousReviewDecisions>',
        );
    });

    it('includes other-file SENT history for moved diagnoses', async () => {
        // Guard for the fix: matching by basename alone must not leak a
        // decision from libs/a/x.ts into libs/b/x.ts when both are full paths.
        expect(
            await promptFor('libs/other/prompts/replyAddressedToKody.ts'),
        ).toContain('<PreviousReviewDecisions>');
    });
});

describe('history beyond the anchor file', () => {
    it('includes PR-level decisions for a file-anchored candidate', async () => {
        expect(
            await promptFor('src/caller.ts', {}, [
                { ...decision, relevantFile: undefined },
            ]),
        ).toContain('Id: round-a');
    });

    it('provides other-file history', async () => {
        expect(await promptFor('src/caller.ts')).toContain('Id: round-a');
    });
});

// Cost regression: the verifier already has tools; do not duplicate whole-file evidence.
describe('lean verifier input', () => {
    it('does not append diff or finder read payloads to each candidate', () => {
        const candidate = {
            relevantFile: FULL,
            suggestionContent: 'Check arithmetic',
            existingCode: 'x',
            improvedCode: 'y',
        } as any;
        const prompt = (verifierPromptFor as any)(
            candidate,
            [decision],
            'FULL_DIFF_SENTINEL: excerpt supplied by caller',
            'ALL_READS_SENTINEL',
        );
        expect(prompt).not.toContain('FULL_DIFF_SENTINEL');
        expect(prompt).not.toContain('ALL_READS_SENTINEL');
    });
});

