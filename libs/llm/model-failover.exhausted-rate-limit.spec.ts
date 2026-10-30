import { shouldFailoverToNextModel } from './model-failover';
import { classifyLLMError, LlmErrorCategory } from './error-classifier';

/**
 * A 429 that outlived the executor's own backoff must cascade.
 *
 * The Curseduca outage is the case this exists for: Z.AI answers a spent
 * prepaid balance with HTTP 429 and the words "Insufficient balance or no
 * resource package. Please recharge." The quota vocabulary knew neither
 * phrase, so the error read as RATE_LIMIT, `shouldFailoverToNextModel`
 * returned false, and the org's configured fallback sat idle for hours while
 * every review failed — 300+ occurrences in six hours.
 *
 * Adding those two phrases fixes THAT vendor. What fixes the CLASS is the fact
 * the error already carries: the SDK retried the same model four times with
 * exponential backoff and it kept failing. Backoff is the remedy for a real
 * rate limit, so outliving it disproves the label without reading a word of
 * the vendor's prose.
 */

/** An APICallError as the provider SDK builds it. */
const apiError = (message: string, statusCode = 429) => {
    const e: any = new Error(message);
    e.name = 'AI_APICallError';
    e.statusCode = statusCode;
    return e;
};

/** The SDK's RetryError, with the reason it actually sets. */
const retryError = (
    inner: Error,
    reason: 'maxRetriesExceeded' | 'errorNotRetryable' = 'maxRetriesExceeded',
) => {
    const e: any = new Error(
        `Failed after 4 attempts. Last error: ${inner.name}: ${inner.message}`,
    );
    e.name = 'AI_RetryError';
    e.reason = reason;
    e.lastError = inner;
    e.cause = inner;
    return e;
};

const ZAI_SPENT = '[1113][Insufficient balance or no resource package. Please recharge.][2026]';

describe('a 429 that exhausted its same-model retries', () => {
    it('reaches the fallback for Z.AI by VOCABULARY, not by this rule', () => {
        // Stated precisely so this file cannot flatter itself. Once "insufficient
        // balance"/"recharge" are in the quota list, Z.AI classifies as
        // QUOTA_EXCEEDED and cascades down the TERMINAL path — reverting the
        // exhaustion rule leaves this passing. It is pinned as the first of two
        // independent layers, not as evidence for the second.
        expect(classifyLLMError(apiError(ZAI_SPENT)).category).toBe(
            LlmErrorCategory.QUOTA_EXCEEDED,
        );
        expect(shouldFailoverToNextModel(retryError(apiError(ZAI_SPENT)))).toBe(
            true,
        );
    });

    it('cascades for wording the quota vocabulary has never seen', () => {
        // THE point of the rule. This sentence is invented: no phrase in
        // `looksLikeQuota` appears in it, so classification lands on RATE_LIMIT
        // exactly as Z.AI's did before its words were added. Exhaustion still
        // carries it to the fallback — which is what stops the NEXT vendor from
        // becoming an outage instead of a config change.
        const novel = apiError('error 77: wallet drained, top up to continue');
        expect(classifyLLMError(novel).category).toBe(
            LlmErrorCategory.RATE_LIMIT,
        );
        expect(shouldFailoverToNextModel(retryError(novel))).toBe(true);
    });

    it.each([
        ['a vendor that says nothing about money', 'error 77: wallet drained, top up to continue'],
        ['a vendor that only gives a code', 'E4021: service unavailable for this account'],
        ['a vendor writing in its own language', 'saldo insuficiente para completar a operacao'],
    ])('carries %s to the fallback on exhaustion alone', (_label, message) => {
        // Three wordings, none of them in the quota vocabulary, all landing on
        // RATE_LIMIT. If the rule hangs on one hand-picked sentence it is not a
        // rule — so the class is sampled, not the instance.
        const err = apiError(message);
        expect(classifyLLMError(err).category).toBe(LlmErrorCategory.RATE_LIMIT);
        expect(shouldFailoverToNextModel(err)).toBe(false);
        expect(shouldFailoverToNextModel(retryError(err))).toBe(true);
    });

    it('does NOT cascade when the retries were never spent', () => {
        // A bare 429 straight off the wire: the limiter owns this one. Swapping
        // models here would defeat the rate gate and hammer providers, which is
        // the reason the RATE_LIMIT veto exists in the first place.
        expect(shouldFailoverToNextModel(apiError('rate limit exceeded'))).toBe(
            false,
        );
    });

    it('does NOT cascade when the SDK declined to retry at all', () => {
        // `errorNotRetryable` means nothing was tested by repetition, so the
        // rate-limit reading stands unchallenged.
        const inner = apiError('rate limit exceeded');
        expect(
            shouldFailoverToNextModel(retryError(inner, 'errorNotRetryable')),
        ).toBe(false);
    });

    it('still refuses an abort, even wrapped in an exhausted RetryError', () => {
        // Latency, not the model. Re-running burns the whole budget again, and
        // that gate must keep winning over this one.
        const aborted: any = new Error('This operation was aborted');
        aborted.name = 'AbortError';
        expect(shouldFailoverToNextModel(retryError(aborted))).toBe(false);
    });

    it('leaves the other categories where they were', () => {
        const overflow: any = new Error('maximum context length exceeded');
        overflow.statusCode = 400;
        expect(classifyLLMError(overflow).category).toBe(
            LlmErrorCategory.CONTEXT_OVERFLOW,
        );
        expect(shouldFailoverToNextModel(retryError(overflow))).toBe(false);

        // UNKNOWN stays conservative on purpose: exhaustion says the failure is
        // persistent, not what it IS, so a 2nd billed call would be a guess.
        const mystery: any = new Error('something went sideways');
        expect(classifyLLMError(mystery).category).toBe(
            LlmErrorCategory.UNKNOWN,
        );
        expect(shouldFailoverToNextModel(retryError(mystery))).toBe(false);

        // A terminal category never needed exhaustion to cascade.
        const badKey: any = new Error('invalid api key');
        badKey.statusCode = 401;
        expect(shouldFailoverToNextModel(badKey)).toBe(true);
    });
});
