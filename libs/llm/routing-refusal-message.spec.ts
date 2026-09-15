import { classifyLLMError, LlmErrorCategory } from './error-classifier';

/**
 * A 404 from an aggregator carries two different failures under one status.
 *
 * "No such model" is fixed by correcting the id. "No upstream your account
 * allows serves this model" is fixed on the provider's routing settings, and
 * nothing about the id or the key will help. Both arrive as 404 with
 * MODEL_NOT_FOUND, so the only thing separating them is the body — which is why
 * the advice has to read it.
 *
 * This mattered: a customer followed "verify the model name in your settings"
 * for a day, rewriting a correct name and regenerating a working key, while the
 * provider's own reply named the setting to change.
 */
const routing404 = () =>
    Object.assign(new Error(
        'No allowed providers are available for the selected model. ' +
        'Providers serving deepseek/deepseek-v4-pro: fireworks, deepinfra, baseten, ' +
        "but your account's allowed-providers setting permits only: groq, z-ai.",
    ), { status: 404 });

const missingModel404 = () =>
    Object.assign(new Error('model "gpt-nope" does not exist'), { status: 404 });

describe('a 404 that is about routing, not about the model id', () => {
    it('stops telling the user to check a model name that is correct', () => {
        const { friendlyMessage } = classifyLLMError(routing404(), 'open_router');

        expect(friendlyMessage).not.toMatch(/verify the model name/i);
    });

    it('names routing as the cause and clears the model', () => {
        const { friendlyMessage } = classifyLLMError(routing404(), 'open_router');

        expect(friendlyMessage).toMatch(/route/i);
        expect(friendlyMessage).toMatch(/model is fine/i);
    });

    it('still names the provider so the admin knows where to go', () => {
        const { friendlyMessage } = classifyLLMError(routing404(), 'open_router');

        expect(friendlyMessage).toContain('open_router');
    });

    it('leaves a genuine missing model alone', () => {
        // The original advice is right for the case it was written for; the fix
        // must not swallow it.
        const { friendlyMessage, category } = classifyLLMError(
            missingModel404(),
            'open_router',
        );

        expect(category).toBe(LlmErrorCategory.MODEL_NOT_FOUND);
        expect(friendlyMessage).toMatch(/verify the model name/i);
    });

    it.each([
        ["your account's allowed-providers setting permits only: groq"],
        ['No allowed providers are available for the selected model'],
        ['the allowed providers list for this account is empty'],
    ])('recognises the wording variant: %s', (text) => {
        // One vendor, several phrasings of the same refusal — matching only the
        // string we happened to see first would regress on the next one.
        const { friendlyMessage } = classifyLLMError(
            Object.assign(new Error(text), { status: 404 }),
            'open_router',
        );

        expect(friendlyMessage).toMatch(/route/i);
    });
});
