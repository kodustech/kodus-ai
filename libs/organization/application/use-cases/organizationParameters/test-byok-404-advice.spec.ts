import { notFoundAdvice } from './test-byok-connection.use-case';

/**
 * A 404 has to say what the provider said, not what we guessed.
 *
 * The fixed sentence this replaced offered two causes — a wrong base URL, or an
 * API path missing from the plan — and a customer hit a 404 that was neither.
 * OpenRouter had answered in full: the account's allowed-providers setting
 * permitted no upstream serving the requested model, and it named the page to
 * change it. We overwrote that with the guess, so the customer went on
 * regenerating a key that was never the problem while the real fix sat unread in
 * a field the screen did not render.
 *
 * The rule these pin is therefore about PRECEDENCE, not wording: whenever the
 * provider explained itself, we stop guessing.
 */
const ALLOWED_PROVIDERS_404 =
    'No allowed providers are available for the selected model. ' +
    'Providers serving deepseek/deepseek-v4-pro-20260423: fireworks, deepinfra, baseten, ' +
    "but your account's allowed-providers setting permits only: groq, z-ai, openai. " +
    'To change your allowed providers, visit: https://openrouter.ai/settings/privacy.';

describe('notFoundAdvice', () => {
    it('never blames the base URL when the provider gave a reason', () => {
        // The precedence rule, stated as the one thing that must not happen.
        const advice = notFoundAdvice(ALLOWED_PROVIDERS_404);

        expect(advice.toLowerCase()).not.toContain('base url');
        expect(advice.toLowerCase()).not.toContain('plan');
    });

    it('names routing as the cause when no upstream serves the model', () => {
        const advice = notFoundAdvice(ALLOWED_PROVIDERS_404);

        expect(advice.toLowerCase()).toContain('route');
        // And clears the key, because that is what the customer was changing.
        expect(advice.toLowerCase()).toContain('not a problem with the key');
    });

    it.each([
        ['the hyphenated spelling', "your account's allowed-providers setting"],
        ['the spaced spelling', 'your account allowed providers list is empty'],
        ['the leading phrasing', 'No allowed providers are available'],
    ])('recognises %s', (_label, said) => {
        // One vendor, three wordings across its own messages — matching only the
        // exact string we happened to see first would silently fall through to
        // the generic advice on the next one.
        expect(notFoundAdvice(said).toLowerCase()).toContain('route');
    });

    it('defers to the provider for a reason it does not recognise', () => {
        const advice = notFoundAdvice('Deployment "gpt-x" was not found in this resource.');

        expect(advice.toLowerCase()).not.toContain('base url');
        expect(advice.toLowerCase()).toContain('explanation is below');
    });

    it.each([[undefined], [''], ['   ']])(
        'keeps the endpoint guess when the provider said nothing (%p)',
        (said) => {
            // The original sentence was written for exactly this case and is
            // still the best available guess when there is nothing to defer to.
            const advice = notFoundAdvice(said as string | undefined);

            expect(advice).toContain('base URL');
        },
    );
});
