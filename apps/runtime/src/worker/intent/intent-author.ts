import type { IntentProbe } from '@libs/runtime/contracts/run-plan';
import {
    checkIntentProbes,
    hasStatedIntent,
    INTENT_AUTHOR_LIMITS,
    INTENT_AUTHOR_RETRY,
    INTENT_AUTHOR_VERSION,
    intentAuthorMessages,
    type IntentAuthorInput,
    isIntentAnswer,
} from '@libs/runtime/planner/intent-author';

import type { LlmGateway, LlmResponse } from '../agent/llm-gateway';
import type { RethrowPredicate } from './intent-classifier';

// The intent author's turn (docs/runtime/intent-oracle.md): one
// `runtime.intent_author` call through the product's gateway (the org's BYOK
// and the Run's budget), no tools and no exploration. Its prompt and checks
// are libs/runtime/planner/intent-author.ts; this only makes the call. A PR
// that states nothing spends no turn, an answer that is not JSON (cut at its
// output budget, kr-shop #8) is asked again once, and a failed turn leaves
// the Run with its base comparison only.

export type IntentAuthorResult =
    | { status: 'authored'; version: string; probes: IntentProbe[]; dropped: { reason: string }[]; usage: LlmResponse['usage'] }
    | { status: 'no_stated_intent'; version: string }
    | { status: 'unavailable'; version: string; reason: string };

export interface StatedIntentAuthor {
    author(input: IntentAuthorInput, ctx: { runId: string; organizationId: string; runToken: string }): Promise<IntentAuthorResult>;
}

export class IntentAuthor implements StatedIntentAuthor {
    constructor(
        private readonly llm: LlmGateway,
        private readonly opts: { rethrow?: RethrowPredicate } = {},
    ) {}

    async author(input: IntentAuthorInput, ctx: { runId: string; organizationId: string; runToken: string }): Promise<IntentAuthorResult> {
        const version = INTENT_AUTHOR_VERSION;
        if (!hasStatedIntent(input)) return { status: 'no_stated_intent', version };
        try {
            const messages = intentAuthorMessages(input);
            const ask = (m: typeof messages) => this.llm.complete({ ...ctx, task: 'runtime.intent_author', messages: m, maxOutputTokens: INTENT_AUTHOR_LIMITS.maxOutputTokens });
            let res = await ask(messages);
            let usage = res.usage;
            if (!isIntentAnswer(res.text)) {
                res = await ask([...messages, { role: 'user', content: INTENT_AUTHOR_RETRY }]);
                usage = { inputTokens: usage.inputTokens + res.usage.inputTokens, outputTokens: usage.outputTokens + res.usage.outputTokens };
            }
            const checked = checkIntentProbes(res.text, input);
            return { status: 'authored', version, probes: checked.probes, dropped: checked.dropped, usage };
        } catch (e) {
            if (this.opts.rethrow?.(e)) throw e;
            return { status: 'unavailable', version, reason: `intent author unavailable: ${(e as Error)?.message ?? 'error'}`.slice(0, 300) };
        }
    }
}
