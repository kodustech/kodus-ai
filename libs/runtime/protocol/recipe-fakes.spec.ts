import { parseRecipe } from './recipe';

// Fixture digests establish deterministic parsing, not a published image or fidelity claim.
const stripe = `stripe/stripe-mock@sha256:${'a'.repeat(64)}`;
const email = `axllent/mailpit@sha256:${'b'.repeat(64)}`;

describe('declared recipe fakes (#2494)', () => {
    it('normalizes pinned fake services without exposing arbitrary compose capabilities', () => {
        const out = parseRecipe(
            `version: 1\nfakes:\n  stripe: { image: ${stripe}, env: { STRIPE_API_BASE: 'http://stripe-mock:12111' } }\n  email: { image: ${email} }\n`,
        );
        expect(out).toMatchObject({
            ok: true,
            recipe: {
                fakes: [
                    {
                        kind: 'email',
                        service: 'mailpit',
                        image: email,
                        env: {},
                    },
                    {
                        kind: 'stripe',
                        service: 'stripe-mock',
                        image: stripe,
                        env: { STRIPE_API_BASE: 'http://stripe-mock:12111' },
                    },
                ],
            },
        });
        if (out.ok) expect(out.recipe.unapplied ?? []).not.toContain('fakes');
    });
    it('keeps legacy aliases parseable without making up an immutable version', () => {
        expect(
            parseRecipe(
                'version: 1\nfakes: { stripe: true, email: { image: mailpit } }\n',
            ),
        ).toMatchObject({
            ok: true,
            recipe: {
                fakes: [
                    { kind: 'email', image: 'mailpit' },
                    { kind: 'stripe', image: 'stripe-mock' },
                ],
            },
        });
    });
    it.each([
        'fakes: { arbitrary: { image: alpine } }',
        'fakes: { stripe: { image: evil/stripe-mock } }',
        'fakes: { stripe: { image: stripe/stripe-mock:latest } }',
        'fakes: { stripe: { image: stripe-mock, privileged: true } }',
        'fakes: { stripe: false }',
        'fakes: { stripe: { image: stripe-mock, env: { __proto__: value } } }',
        'fakes: { stripe: { image: stripe-mock, env: { constructor: value } } }',
        `fakes: { stripe: { image: stripe-mock, env: { SAFE: '${'á'.repeat(1500)}' } } }`,
        'fakes: { stripe: { image: stripe-mock, env: { NODE_OPTIONS: "--require /tmp/x" } } }',
        'fakes: { stripe: { image: stripe-mock, env: { API_TOKEN: customer-secret } } }',
        'fakes: { stripe: { image: stripe-mock, env: { SAFE: "a\\nb" } } }',
        'fakes: { stripe: { image: stripe-mock, env: { SAME: a } }, email: { image: mailpit, env: { SAME: b } } }',
        'services: { compose: { env: { SAME: a } } }\nfakes: { stripe: { image: stripe-mock, env: { SAME: b } } }',
    ])('refuses an unsupported or unsafe declaration: %s', (text) => {
        expect(parseRecipe(`version: 1\n${text}\n`)).toMatchObject({
            ok: false,
        });
    });
});
