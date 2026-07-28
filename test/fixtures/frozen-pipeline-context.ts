import { produce } from 'immer';

/**
 * Hands a stage spec the context shape production actually gives it: frozen.
 *
 * BasePipelineStage.updateContext runs `produce(context, updater)` (see
 * base-stage.abstract.ts), and Immer auto-freezes what produce returns. So from
 * the second stage onward every stage receives a DEEP-FROZEN context, and a
 * direct write — `context.heavy = x`, `pullRequest.heavy = x`,
 * `context.errors.push(e)` — throws "Cannot assign to read only property".
 *
 * Specs that build a plain object never see that: the write succeeds, the test
 * passes, and the bug ships. This exact blind spot cost two incidents in one
 * week — #1522 (context.heavy in agent-review, ~27h of reviews finishing with 0
 * suggestions) and c886e369a (pullRequest.heavy in create-file-comments, the
 * same class, found only after the first fix shipped) — plus a third instance
 * in finish-comments' own error handler, where `context.errors.push()` threw
 * INSIDE the catch and replaced the real error with a frozen-mutation one.
 *
 * Freezing by default means the next instance fails in CI instead of in QA.
 * Nothing to remember, nothing to opt into.
 *
 * Use it in the builder, not per-test:
 *
 *   const baseContext = (over = {}) =>
 *       frozenContext({ ...defaults, ...over } as CodeReviewPipelineContext);
 *
 * If a spec legitimately needs a mutable context (asserting on a builder, say),
 * skip this and say why — an unfrozen context is now the exception.
 */
export function frozenContext<T>(context: T): T {
    return produce(context, () => {});
}
