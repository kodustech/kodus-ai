import type { BYOKConfig, BYOKConnectInput } from '../_types';
import { ADVANCED_FIELDS } from './_modals/edit-key/_components/credential-forms';
import {
    PROVIDER_SETTING_KEYS,
    providerSettingDefaults,
    unownedStoredSettings,
} from './_modals/edit-key/credential-config';
import { buildByokBlob, credentialSettingsFromConfig } from './byok-write';

/**
 * A credential's `settings` survive a save made about something else.
 *
 * The server does not merge this object — it REPLACES it, carrying over only the
 * encrypted aws* fields. Every consequence below follows from that one fact:
 * whatever a screen fails to re-send is deleted from the customer's config, by a
 * save the customer made for another reason entirely.
 *
 * Two defects lived in that gap at the same time, which is why the symptom read
 * as contradictory ("a new provider keeps the pin, an existing one never does"):
 *
 *  - the model form RENDERED the OpenRouter pin but only the `add-new-provider`
 *    branch ever sent credential settings, so on an existing credential the
 *    value was validated, toasted as saved, and dropped in the browser;
 *  - the "Edit provider" panel DID send settings, rebuilt from a form that
 *    never rendered those fields, so rotating a key erased the pin.
 *
 * So the assertions are written against the shared rule rather than against
 * OpenRouter: the fields come from the registry, and a provider that registers
 * a field without wiring it fails here instead of in production.
 */

const cfg = (over: Partial<BYOKConnectInput> = {}): BYOKConnectInput =>
    ({
        provider: 'open_router',
        model: 'm',
        apiKey: '',
        ...over,
    }) as BYOKConnectInput;

const stored = (settings: Record<string, unknown>): BYOKConfig => ({
    version: 2,
    credentials: [
        {
            id: 'cred-main',
            provider: 'open_router',
            apiKey: 'cipher',
            settings,
        },
        {
            id: 'cred-other',
            provider: 'openai',
            apiKey: 'cipher2',
            settings: { baseURL: 'https://other' },
        },
    ],
    models: [
        { id: 'model-main', credentialId: 'cred-main', model: 'a' },
        { id: 'model-fallback', credentialId: 'cred-main', model: 'b' },
    ],
    routing: { defaultModelId: 'model-main' },
});

const PIN = { openrouterProviderOrder: ['moonshot', 'together'] };
const credOf = (blob: BYOKConfig, id: string) =>
    blob.credentials.find((c) => c.id === id)!;

describe('credential settings survive the save that is not about them', () => {
    it('writes the pin through an edit-model save (it never left the browser)', () => {
        // The migrated shape every production config is in: fixed ids, one
        // credential, two models pointing at it.
        const blob = buildByokBlob(stored({ baseURL: 'https://x' }), {
            kind: 'edit-model',
            modelId: 'model-main',
            model: { model: 'a' },
            credentialSettings: { baseURL: 'https://x', ...PIN },
        });

        expect(credOf(blob, 'cred-main').settings).toEqual({
            baseURL: 'https://x',
            ...PIN,
        });
    });

    it('writes it through add-existing-provider, and touches no other credential', () => {
        const blob = buildByokBlob(stored(PIN), {
            kind: 'add-existing-provider',
            credentialId: 'cred-main',
            model: { model: 'c' },
            credentialSettings: { ...PIN, openrouterAllowFallbacks: false },
        });

        expect(credOf(blob, 'cred-main').settings).toEqual({
            ...PIN,
            openrouterAllowFallbacks: false,
        });
        expect(credOf(blob, 'cred-other').settings).toEqual({
            baseURL: 'https://other',
        });
    });

    it('keeps the stored settings when a save carries none', () => {
        // Routing-only and untouched-credential saves must stay non-destructive.
        const blob = buildByokBlob(stored(PIN), {
            kind: 'edit-model',
            modelId: 'model-main',
            model: { model: 'a' },
        });

        expect(credOf(blob, 'cred-main').settings).toEqual(PIN);
    });

    it('lets the user actually REMOVE a pin', () => {
        // The mirror of the bug: if an empty result were treated as "no opinion",
        // unpinning would silently keep the old value forever.
        const blob = buildByokBlob(stored(PIN), {
            kind: 'edit-model',
            modelId: 'model-main',
            model: { model: 'a' },
            credentialSettings: {},
        });

        expect(credOf(blob, 'cred-main').settings).toEqual({});
    });

    it('never echoes a stored key back as a value', () => {
        // Blank apiKey is the contract for "keep the ciphertext".
        const blob = buildByokBlob(stored(PIN), {
            kind: 'edit-model',
            modelId: 'model-main',
            model: { model: 'a' },
            credentialSettings: PIN,
        });

        expect(credOf(blob, 'cred-main').apiKey).toBe('');
    });
});

describe('seeding a form from the credential it will overwrite', () => {
    it('seeds every non-secret field the provider registered', () => {
        const seeded = providerSettingDefaults('open_router', {
            ...PIN,
            openrouterAllowFallbacks: false,
        });

        expect(seeded).toEqual({ ...PIN, openrouterAllowFallbacks: false });
    });

    it('never seeds a secret — blank is what keeps the stored ciphertext', () => {
        const seeded = providerSettingDefaults('amazon_bedrock', {
            awsRegion: 'us-east-1',
            awsAccessKeyId: '••••',
            awsSecretAccessKey: '••••',
            awsBearerToken: '••••',
            awsSessionToken: '••••',
        });

        expect(seeded).toEqual({ awsRegion: 'us-east-1' });
    });

    it('seeds nothing for a provider with no registered fields', () => {
        expect(
            providerSettingDefaults('openai', { baseURL: 'https://x' }),
        ).toEqual({});
    });

    it('carries through a stored key no form owns', () => {
        // A setting written by a newer API or a screen this build does not have.
        expect(
            unownedStoredSettings({
                ...PIN,
                baseURL: 'https://x',
                futureKnob: 7,
            }),
        ).toEqual({ futureKnob: 7 });
    });

    it('does not carry a key a form owns — clearing it must really clear it', () => {
        expect(unownedStoredSettings({ baseURL: 'https://x', ...PIN })).toEqual(
            {},
        );
    });
});

describe('the registry is wired, not just declared', () => {
    it.each(Object.keys(ADVANCED_FIELDS))(
        '%s registers the setting keys its advanced form writes',
        (provider) => {
            // A provider that renders advanced fields without registering them
            // would be seeded blank and erased on the next save — the exact
            // shape of the OpenRouter bug. Fail here, not in production.
            const keys = (
                PROVIDER_SETTING_KEYS as Record<string, readonly string[]>
            )[provider];
            expect(keys?.length).toBeGreaterThan(0);
        },
    );

    it.each(Object.entries(PROVIDER_SETTING_KEYS))(
        '%s round-trips every non-secret key it registers',
        (provider, keys) => {
            // Seed → submit → the value comes back out. A key that survives the
            // seed but is dropped by the builder is invisible until a customer
            // reports it gone.
            // The sample has to match each field's TYPE: the submit builder
            // copies a boolean only when it IS a boolean, so a stringly-typed
            // sample would fail here for a reason that has nothing to do with
            // the round trip under test.
            const sample: Record<string, unknown> = {};
            for (const key of keys as readonly string[]) {
                sample[key] = key.endsWith('Order')
                    ? ['x']
                    : /allow|enable/i.test(key)
                      ? true
                      : 'v';
            }

            const seeded = providerSettingDefaults(provider, sample) as Record<
                string,
                unknown
            >;
            const sent = credentialSettingsFromConfig(cfg(seeded)) ?? {};

            for (const key of Object.keys(seeded)) {
                expect(sent[key]).toEqual(seeded[key]);
            }
        },
    );
});
