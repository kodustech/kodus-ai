/**
 * Vertex BUILD + SHAPE contract — the half of this provider no live call reaches.
 *
 * WHY THIS FILE EXISTS
 * `vertex.spec.ts` next door is about usage normalization, and its one
 * end-to-end case deliberately passes `apiKey: 'not-a-service-account-json'`,
 * which means it exercises the AI-Studio FALLBACK rather than Vertex. So the
 * Vertex path itself — the Service Account decode, the choice between the Gemini
 * and the Anthropic-MaaS builder, the location default — had no test at all,
 * while the live tier that would have covered it is parked behind a GCP quota
 * grant we do not hold (see byok-reasoning.live.spec.ts).
 *
 * That combination is what this file closes. None of it needs a project, a
 * credential or a network: `vertexModelFromSaJson` only requires a parseable SA
 * JSON carrying `project_id`, so a fake one reaches every decision the real one
 * would, and the SDK factories are mocked so the assertion is about WHAT WE
 * BUILD rather than what Google answers.
 *
 * It does not replace the live rows. A live call answers "does Vertex still
 * accept this?"; these answer "is this still what we send?" — and for the
 * self-hosted installs running Claude on Vertex, the second question currently
 * has no other answer anywhere in the repo.
 */
// The factories are created INSIDE each factory: `jest.mock` is hoisted above
// the `const` declarations, so a factory closing over an outer const reads it in
// the temporal dead zone and throws before a single test runs. The mocked
// bindings come back through the imports below, which resolve to these.
jest.mock('@ai-sdk/google-vertex', () => ({
    createVertex: jest.fn(() => jest.fn((id: string) => ({ __gemini: id }))),
}));
jest.mock('@ai-sdk/google-vertex/anthropic', () => ({
    createVertexAnthropic: jest.fn(() => jest.fn((id: string) => ({ __maas: id }))),
}));
jest.mock('@ai-sdk/google', () => ({
    createGoogleGenerativeAI: jest.fn(() => jest.fn((id: string) => ({ __aistudio: id }))),
}));
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { createVertex as rawCreateVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic as rawCreateVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createGoogleGenerativeAI as rawCreateGoogleGenerativeAI } from '@ai-sdk/google';

import { vertexModule } from './index';
import { parseSaCredentials, vertexModelFromSaJson } from '../../model-builders';

const createVertex = rawCreateVertex as unknown as jest.Mock;
const createVertexAnthropic = rawCreateVertexAnthropic as unknown as jest.Mock;
const createGoogleGenerativeAI = rawCreateGoogleGenerativeAI as unknown as jest.Mock;

/** A Service Account shaped like the real thing, with no real key in it. */
const SA = {
    type: 'service_account',
    project_id: 'kodus-test-project',
    private_key_id: 'deadbeef',
    private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
    client_email: 'unit-test@kodus-test-project.iam.gserviceaccount.com',
};
const SA_JSON = JSON.stringify(SA);
const SA_B64 = Buffer.from(SA_JSON).toString('base64');

beforeEach(() => jest.clearAllMocks());

describe('parseSaCredentials — both encodings a customer can paste', () => {
    it('reads raw JSON', () => {
        expect(parseSaCredentials(SA_JSON)?.project_id).toBe('kodus-test-project');
    });

    it('reads base64 JSON — what the BYOK field actually stores', () => {
        expect(parseSaCredentials(SA_B64)?.project_id).toBe('kodus-test-project');
    });

    it('tolerates surrounding whitespace, which a paste carries', () => {
        expect(parseSaCredentials(`  ${SA_B64}\n`)?.project_id).toBe('kodus-test-project');
    });

    it('returns null for anything that is not SA JSON', () => {
        for (const bad of ['', '   ', 'AIzaSyD-not-a-service-account', 'null', '{"no":"project"}']) {
            const parsed = parseSaCredentials(bad);
            expect(parsed?.project_id).toBeUndefined();
        }
    });
});

describe('vertexModelFromSaJson — which builder, and with what settings', () => {
    it('routes a claude-* id through Anthropic MaaS, not the Gemini builder', () => {
        vertexModelFromSaJson(SA_B64, 'claude-sonnet-5', 'global');

        expect(createVertexAnthropic).toHaveBeenCalledTimes(1);
        expect(createVertex).not.toHaveBeenCalled();
        expect(createVertexAnthropic).toHaveBeenCalledWith(
            expect.objectContaining({ project: 'kodus-test-project', location: 'global' }),
        );
    });

    it('routes a gemini id through the Gemini builder', () => {
        vertexModelFromSaJson(SA_B64, 'gemini-3.1-pro-preview', 'global');

        expect(createVertex).toHaveBeenCalledTimes(1);
        expect(createVertexAnthropic).not.toHaveBeenCalled();
    });

    it('defaults the location to `global` when the slot omits it', () => {
        // Regional endpoints do not serve current Claude at all — us-east5
        // answers 404 for a bare `claude-sonnet-4-6`, measured 2026-09-17. The
        // default is what keeps a slot with no location working.
        vertexModelFromSaJson(SA_B64, 'claude-sonnet-5');

        expect(createVertexAnthropic).toHaveBeenCalledWith(
            expect.objectContaining({ location: 'global' }),
        );
    });

    it('honours an explicit region instead of the default', () => {
        vertexModelFromSaJson(SA_B64, 'gemini-2.5-pro', 'us-central1');

        expect(createVertex).toHaveBeenCalledWith(
            expect.objectContaining({ location: 'us-central1' }),
        );
    });

    it('passes the parsed credentials to googleAuthOptions', () => {
        vertexModelFromSaJson(SA_B64, 'claude-sonnet-5', 'global');

        const settings = createVertexAnthropic.mock.calls[0][0] as any;
        expect(settings.googleAuthOptions.credentials.client_email).toBe(SA.client_email);
    });

    it('returns null — never a half-built model — when the value is not an SA', () => {
        expect(vertexModelFromSaJson('AIzaSyD-not-a-service-account', 'gemini-2.5-pro')).toBeNull();
        expect(createVertex).not.toHaveBeenCalled();
        expect(createVertexAnthropic).not.toHaveBeenCalled();
    });
});

describe('vertexModule.build — the silent AI-Studio fallback', () => {
    it('builds a real Vertex model when the slot holds a Service Account', () => {
        vertexModule.build({ model: 'claude-sonnet-5', apiKey: SA_B64, vertexLocation: 'global' } as any);

        expect(createVertexAnthropic).toHaveBeenCalledTimes(1);
        expect(createGoogleGenerativeAI).not.toHaveBeenCalled();
    });

    /**
     * PINS A TRAP, and does not bless it. Typing an AI Studio key (`AIzaSy…`)
     * into the Vertex slot is the obvious mistake to make, and today it does not
     * fail — it quietly builds an AI Studio model instead. Different account,
     * different quota, different bill, and a customer who believes they are on
     * Vertex. The behaviour is pinned here so that changing it is a deliberate
     * act with a failing test attached, rather than a silent decision nobody
     * revisits.
     */
    it('falls back to AI Studio for a non-SA key — SILENTLY, which is the hazard', () => {
        vertexModule.build({ model: 'gemini-2.5-flash', apiKey: 'AIzaSyD-not-a-service-account' } as any);

        expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
            apiKey: 'AIzaSyD-not-a-service-account',
        });
        expect(createVertex).not.toHaveBeenCalled();
        expect(createVertexAnthropic).not.toHaveBeenCalled();
    });
});

/**
 * THE SHAPE PER BAND — the fact the gated live rows were written to check.
 *
 * `resolveAnthropicModelTraits` sorts Claude ids into generations, and the id is
 * the only thing that selects one. Two ids in the same band build the same
 * request; two ids one band apart build mutually exclusive ones, and sending the
 * wrong one is a 400 on the customer's review rather than on ours. Every number
 * below was measured against the real module, not read off a doc.
 */
describe('vertexModule.reasoning — one band, one shape', () => {
    const shape = (model: string, effort: string) =>
        (vertexModule as any).reasoning({ model } as any, effort);

    it('adaptive-4-6 and modern both emit adaptive thinking + effort', () => {
        const expected = {
            anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
        };
        expect(shape('claude-sonnet-4-6', 'medium')).toEqual(expected);
        // Identical on purpose: this is WHY the live tier needs a temperature to
        // tell the two bands apart (see byok-reasoning.live.spec.ts), and why a
        // second row asserting only the thinking shape would be redundant.
        expect(shape('claude-sonnet-5', 'medium')).toEqual(expected);
        expect(shape('claude-opus-5', 'medium')).toEqual(expected);
    });

    it('the legacy band emits an explicit budget, scaled by effort', () => {
        // Pinned numbers: a live row declaring `maxOutputTokens` BELOW its own
        // budget is rejected by the protocol, so these values are load-bearing
        // for anyone adding one.
        expect(shape('claude-haiku-4-5', 'low')).toEqual({
            anthropic: { thinking: { type: 'enabled', budgetTokens: 5_000 } },
        });
        expect(shape('claude-haiku-4-5', 'medium')).toEqual({
            anthropic: { thinking: { type: 'enabled', budgetTokens: 15_000 } },
        });
        expect(shape('claude-haiku-4-5', 'high')).toEqual({
            anthropic: { thinking: { type: 'enabled', budgetTokens: 40_000 } },
        });
    });

    it('Gemini-on-Vertex never speaks the Anthropic protocol', () => {
        // gemini-3 takes a LEVEL, older Gemini a BUDGET — two different fields
        // under the same provider id.
        expect(shape('gemini-3.1-pro-preview', 'medium')).toEqual({
            google: { thinkingConfig: { thinkingLevel: 'medium' } },
        });
        expect(shape('gemini-2.5-pro', 'medium')).toEqual({
            google: { thinkingConfig: { thinkingBudget: 15_000 } },
        });
    });

    it('`none` says thinking is OFF out loud on the adaptive band', () => {
        // Not an omission — an adaptive model thinks by default, and a
        // structured (forced tool_choice) call while thinking is a 400. The
        // explicit disable is what keeps Kody Rules working on that band.
        expect(shape('claude-sonnet-4-6', 'none')).toEqual({
            anthropic: { thinking: { type: 'disabled' } },
        });
    });

    it('`none` is an omission everywhere it can be', () => {
        // The legacy band and Gemini do not think unless asked, so there is
        // nothing to turn off and no field to send.
        expect(shape('claude-haiku-4-5', 'none')).toEqual({});
        expect(shape('gemini-3.1-pro-preview', 'none')).toEqual({});
    });
});

describe('vertexModule.temperaturePolicy — where the bands really diverge', () => {
    const policy = (model: string) =>
        (vertexModule as any).temperaturePolicy({ model } as any);

    it('the 4.7+/5 line cannot take a temperature', () => {
        // On that line a temperature reaching the wire is a 400, and the SDK
        // only strips it by itself while thinking is ON — so this policy is the
        // thing standing between a thinking-off structured call and an error.
        expect(policy('claude-sonnet-5')).toEqual({ kind: 'unsupported' });
        expect(policy('claude-opus-5')).toEqual({ kind: 'unsupported' });
        expect(policy('claude-opus-4-7')).toEqual({ kind: 'unsupported' });
    });

    it('4.6, the legacy band and Gemini all take one', () => {
        expect(policy('claude-sonnet-4-6')).toEqual({ kind: 'adjustable' });
        expect(policy('claude-haiku-4-5')).toEqual({ kind: 'adjustable' });
        expect(policy('gemini-3.1-pro-preview')).toEqual({ kind: 'adjustable' });
    });
});
