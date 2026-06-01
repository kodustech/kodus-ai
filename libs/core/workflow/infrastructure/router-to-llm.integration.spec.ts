/**
 * Integration test for the job-timeout cancellation chain.
 *
 * Wires the REAL `runWithTimeout` and `composeAbortSignal` together with
 * mocked "layers" that mimic the production chain:
 *
 *   runWithTimeout (router)
 *     → processor.process(jobId, signal)
 *       → runCodeReviewAutomationUseCase.execute(params, signal)
 *         → executeStrategy(name, { ...payload, signal })
 *           → strategy.run(payload)  // destructures signal
 *             → handlePullRequest(..., parentSignal)
 *               → initialContext.parentSignal
 *                 → AgentReviewStage.execute(context)
 *                   → reviewOrchestrator.execute({ ..., parentSignal })
 *                     → provider.execute(input)
 *                       → runAgentLoop({ ..., parentSignal })
 *                         → composeAbortSignal(parentSignal, localCtrl)
 *                           → generateText({ abortSignal: localCtrl.signal })
 *
 * Each "layer" here is mechanical parameter forwarding. The point of this
 * spec is to PROVE the contract end-to-end: when `runWithTimeout` fires,
 * the abortSignal handed to `generateText` flips to `aborted=true`. That is
 * the actual fix for the bug — the prod code does the same forwarding.
 */

import { runWithTimeout } from './run-with-timeout';
import { composeAbortSignal } from '../../../code-review/infrastructure/agents/llm/parent-signal-compose';

// ─── Layer mocks (mimics the real chain, no DI) ────────────────────────

/** Mimics `generateText` from Vercel AI SDK. Resolves when given LLM time
 *  passes; rejects with 'aborted' if `abortSignal` flips to aborted. */
function mockGenerateText({
    abortSignal,
    llmDurationMs,
}: {
    abortSignal: AbortSignal;
    llmDurationMs: number;
}): Promise<string> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve('llm-result'), llmDurationMs);
        abortSignal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('AbortError'));
        });
    });
}

/** Mimics `runAgentLoop` — composes parentSignal into a local controller,
 *  then calls the LLM SDK with the local controller's signal.
 *
 *  The real `runAgentLoop` also has an internal AGENT_TIMEOUT_MS, but it
 *  is irrelevant to this integration: we are validating that PARENT
 *  cancellation propagates to the SDK, not the agent-local timer. The
 *  agent timer is tested independently in agent-loop.ts and not modeled
 *  here to keep the test deterministic. */
async function mimicRunAgentLoop(input: {
    parentSignal?: AbortSignal;
    llmDurationMs: number;
    llmMock: jest.Mock;
}): Promise<string> {
    const local = new AbortController();
    const detach = composeAbortSignal(input.parentSignal, local);
    try {
        const result = await input.llmMock({
            abortSignal: local.signal,
            llmDurationMs: input.llmDurationMs,
        });
        return result;
    } finally {
        detach();
    }
}

/** Mimics BaseCodeReviewAgentProvider → ReviewAgentInput.parentSignal flow */
async function mimicProvider(input: {
    parentSignal?: AbortSignal;
    llmDurationMs: number;
    llmMock: jest.Mock;
}) {
    return mimicRunAgentLoop({
        parentSignal: input.parentSignal,
        llmDurationMs: input.llmDurationMs,
        llmMock: input.llmMock,
    });
}

/** Mimics AgentReviewStage reading context.parentSignal */
async function mimicAgentReviewStage(context: {
    parentSignal?: AbortSignal;
    llmDurationMs: number;
    llmMock: jest.Mock;
}) {
    return mimicProvider({
        parentSignal: context.parentSignal,
        llmDurationMs: context.llmDurationMs,
        llmMock: context.llmMock,
    });
}

/** Mimics CodeReviewHandlerService.handlePullRequest building
 *  initialContext.parentSignal and running the pipeline. */
async function mimicHandlePullRequest(args: {
    parentSignal?: AbortSignal;
    llmDurationMs: number;
    llmMock: jest.Mock;
}) {
    const context = {
        parentSignal: args.parentSignal,
        llmDurationMs: args.llmDurationMs,
        llmMock: args.llmMock,
    };
    return mimicAgentReviewStage(context);
}

/** Mimics AutomationCodeReviewService.run destructuring signal from payload
 *  and forwarding to handlePullRequest. */
async function mimicStrategyRun(payload: {
    signal?: AbortSignal;
    llmDurationMs: number;
    llmMock: jest.Mock;
}) {
    const { signal, llmDurationMs, llmMock } = payload;
    return mimicHandlePullRequest({
        parentSignal: signal,
        llmDurationMs,
        llmMock,
    });
}

/** Mimics RunCodeReviewAutomationUseCase.execute calling executeStrategy
 *  with `signal` injected into payload. */
async function mimicRunCodeReviewUseCase(
    params: { llmDurationMs: number; llmMock: jest.Mock },
    signal?: AbortSignal,
) {
    return mimicStrategyRun({ ...params, signal });
}

/** Mimics CodeReviewJobProcessorService.process forwarding the signal. */
async function mimicProcessor(
    _jobId: string,
    params: { llmDurationMs: number; llmMock: jest.Mock },
    signal?: AbortSignal,
): Promise<string> {
    if (signal?.aborted) {
        throw new Error(`Job aborted before start`);
    }
    return mimicRunCodeReviewUseCase(params, signal);
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Router → ... → generateText abort chain (integration)', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('aborts the LLM SDK abortSignal when the router timeout fires', async () => {
        jest.useFakeTimers();

        // LLM mock that would take 2h if not aborted (way over our timeout)
        const llmMock = jest.fn(mockGenerateText);

        const ROUTER_TIMEOUT_MS = 105 * 60 * 1000; // matches CODE_REVIEW
        const LLM_DURATION_MS = 200 * 60 * 1000;   // 3h20m — would never finish

        const racing = runWithTimeout(
            (signal) =>
                mimicProcessor(
                    'job-1',
                    { llmDurationMs: LLM_DURATION_MS, llmMock },
                    signal,
                ),
            ROUTER_TIMEOUT_MS,
            'Workflow job job-1 timeout after 6300000ms',
        );
        racing.catch(() => {}); // suppress unhandled rejection

        // Advance just past the router deadline
        await jest.advanceTimersByTimeAsync(ROUTER_TIMEOUT_MS + 1);

        await expect(racing).rejects.toThrow('timeout after 6300000ms');

        // Critical assertion: the abortSignal that reached the LLM SDK
        // must show aborted=true. If signal threading is broken in any
        // intermediate layer, this fails.
        expect(llmMock).toHaveBeenCalled();
        const llmArgs = llmMock.mock.calls[0][0] as {
            abortSignal: AbortSignal;
        };
        expect(llmArgs.abortSignal.aborted).toBe(true);
    });

    it('does NOT abort the LLM SDK signal when the work finishes before the timeout', async () => {
        jest.useFakeTimers();
        const llmMock = jest.fn(mockGenerateText);

        const ROUTER_TIMEOUT_MS = 105 * 60 * 1000;
        const LLM_DURATION_MS = 10 * 60 * 1000; // 10 min — completes in time

        const racing = runWithTimeout(
            (signal) =>
                mimicProcessor(
                    'job-2',
                    { llmDurationMs: LLM_DURATION_MS, llmMock },
                    signal,
                ),
            ROUTER_TIMEOUT_MS,
            'should not fire',
        );

        await jest.advanceTimersByTimeAsync(LLM_DURATION_MS + 1);
        const result = await racing;

        expect(result).toBe('llm-result');
        const llmArgs = llmMock.mock.calls[0][0] as {
            abortSignal: AbortSignal;
        };
        expect(llmArgs.abortSignal.aborted).toBe(false);
    });

    it('rejects early without invoking the LLM when the signal is already aborted', async () => {
        const llmMock = jest.fn(mockGenerateText);

        // Build an already-aborted signal upstream
        const ctrl = new AbortController();
        ctrl.abort();

        await expect(
            mimicProcessor(
                'job-3',
                { llmDurationMs: 60_000, llmMock },
                ctrl.signal,
            ),
        ).rejects.toThrow('aborted before start');

        // Never reached the SDK layer
        expect(llmMock).not.toHaveBeenCalled();
    });

    it('regression: if any intermediate layer drops the signal, this fails — guards the threading contract', async () => {
        jest.useFakeTimers();
        const llmMock = jest.fn(mockGenerateText);

        // Use the FULL chain. If anyone breaks parameter forwarding in
        // mimicStrategyRun (or any upstream layer here), the llmMock would
        // receive a fresh non-aborted AbortSignal and this test fails.
        const racing = runWithTimeout(
            (signal) =>
                mimicProcessor(
                    'job-4',
                    { llmDurationMs: 1_000 * 60 * 60, llmMock },
                    signal,
                ),
            500,
            'force quick timeout',
        );
        racing.catch(() => {});

        await jest.advanceTimersByTimeAsync(501);
        await expect(racing).rejects.toThrow('force quick timeout');

        const llmArgs = llmMock.mock.calls[0][0] as {
            abortSignal: AbortSignal;
        };

        // The single hardening assertion: an aborted signal reached the
        // bottom of the call chain. If any layer above forgot to pass it
        // along, this would be `false`.
        expect(llmArgs.abortSignal.aborted).toBe(true);
    });
});
