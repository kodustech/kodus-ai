/**
 * The connection probe never follows a redirect on an endpoint the user types.
 *
 * The SSRF gate resolves the host the user typed and rejects private targets,
 * but it can only vouch for that host. `probeSlotCall` therefore hands every
 * provider module `noRedirectFetch` (`redirect: 'error'`), and a module that
 * builds its client without passing that transport on silently drops the
 * guard: the credential follows a 30x to wherever the endpoint points it (the
 * Gemini module did exactly that until PR #2700).
 *
 * This drives the REAL probe for every provider id, through a global `fetch`
 * stub that mimics undici's redirect modes (see the stub's header). Each
 * user-settable provider is probed twice from a production slot shape:
 *
 *   - its endpoint answers 302 to the cloud metadata address, and the probe
 *     must fail with undici's "unexpected redirect" without that address ever
 *     being asked for (the redirect target would answer like the provider, so
 *     following it would have made the probe pass);
 *   - its endpoint answers normally, and the probe must still succeed through
 *     that one host.
 *
 * Which ids are user-settable is read from each module's `settingsSchema`
 * (does it accept `baseURL`), not from a list, so a new provider is covered on
 * arrival; the partition itself is pinned so the move shows in review.
 *
 * Nothing leaves the process: the stub answers every request, an unrouted host
 * rejects like a DNS failure, and the Node http/https/dns entry points throw.
 */
// First: mocks Vertex's google-auth-library copies before the SDK loads.
import { MOCKED_GOOGLE_AUTH_COPIES } from './probe-transport-matrix.vertex-auth';
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import '@libs/llm/providers';
import { REGISTRY } from '@libs/llm/providers';
import { encrypt } from '@libs/common/utils/crypto';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { KODUS_UPSTREAM_KEY_ENV } from '@libs/llm/providers/kodus';
import PROD_SHAPES from '@libs/llm/testing/__fixtures__/byok-prod-shapes.json';
import { probeSlotCall } from './probe-slot-call';
import {
    causeChain,
    createFetchStub,
    type FetchStub,
    type Route,
} from './probe-transport-matrix.fetch-stub';

/** The address a hostile endpoint would bounce the credential to. */
const METADATA_ORIGIN = 'http://169.254.169.254';
const METADATA_HOST = '169.254.169.254';
const PROBE_TIMEOUT_MS = 10_000;

interface ProdShape extends Record<string, unknown> {
    provider: string;
    model: string;
}

const rows = PROD_SHAPES as ProdShape[];

/** The first production row of a provider, as stored (minus the org count). */
function firstProdRow(provider: string): ProdShape | undefined {
    const row = rows.find((r) => r.provider === provider);
    if (!row) return undefined;
    const { orgs: _orgs, ...shape } = row;
    return shape as ProdShape;
}

function acceptsBaseUrl(id: string): boolean {
    const schema = REGISTRY.get(id).settingsSchema as {
        shape?: Record<string, unknown>;
    };
    return !!schema.shape && 'baseURL' in schema.shape;
}

const ALL_IDS = REGISTRY.ids();
const USER_SETTABLE = ALL_IDS.filter(acceptsBaseUrl);
const FIXED = ALL_IDS.filter((id) => !acceptsBaseUrl(id));

/** The entry host a user-settable slot is pointed at. */
const entryHost = (id: string) => `entry-${id.replace(/_/g, '-')}.example.test`;

/**
 * A production slot for a user-settable id, with its endpoint moved to the
 * stub's host. The stored path is kept (a `/v1` or `/anthropic` suffix
 * changes what the SDK builds). Azure has no production row, so it gets the
 * smallest valid one: a deployment name and a resource endpoint.
 */
function settableSlot(id: string): NormalizedModel {
    const row = firstProdRow(id) ?? { provider: id, model: 'stub-deployment' };
    const storedPath =
        typeof row.baseURL === 'string'
            ? new URL(row.baseURL).pathname.replace(/\/$/, '')
            : id === 'azure'
              ? '/openai'
              : '';
    return {
        ...row,
        provider: id,
        apiKey: encrypt('sk-stub'),
        baseURL: `https://${entryHost(id)}${storedPath}`,
    } as unknown as NormalizedModel;
}

let stub: FetchStub;
const originalFetch = globalThis.fetch;

function useRoutes(routes: Record<string, Route>): FetchStub {
    stub = createFetchStub(routes);
    globalThis.fetch = stub.fetch;
    return stub;
}

async function probeError(slot: NormalizedModel): Promise<unknown> {
    try {
        await probeSlotCall(slot, { timeoutMs: PROBE_TIMEOUT_MS });
    } catch (error) {
        return error;
    }
    throw new Error('the probe succeeded through a redirect');
}

/**
 * undici's refusal, as it reaches the probe's caller. undici rejects with
 * `TypeError('fetch failed')` caused by `Error('unexpected redirect')`; the
 * AI SDK (provider-utils `handleFetchError`) recognises exactly that
 * TypeError and rethrows an `APICallError` "Cannot connect to API: unexpected
 * redirect" whose cause is the inner error. Seeing that inner error is the
 * proof the refusal came from the redirect mode, not from anything else.
 */
function isRedirectRefusal(error: unknown): boolean {
    return causeChain(error).some(
        (e) =>
            e instanceof Error &&
            !(e instanceof TypeError) &&
            e.message === 'unexpected redirect',
    );
}

const offline = () => {
    throw new Error('network access attempted outside the fetch stub');
};

beforeAll(() => {
    jest.spyOn(http, 'request').mockImplementation(offline);
    jest.spyOn(https, 'request').mockImplementation(offline);
    jest.spyOn(dns, 'lookup').mockImplementation(offline as never);
});

afterAll(() => {
    jest.restoreAllMocks();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('probe transport — which endpoints the user can set', () => {
    it('reads the partition from the modules and pins it', () => {
        expect([...USER_SETTABLE].sort()).toEqual([
            'anthropic',
            'anthropic_compatible',
            'azure',
            'google_gemini',
            'moonshot',
            'novita',
            'open_router',
            'openai',
            'openai_compatible',
            'zai',
        ]);
        expect([...FIXED].sort()).toEqual([
            'amazon_bedrock',
            'google_vertex',
            'kodus',
        ]);
    });
});

describe.each(USER_SETTABLE)(
    'probe transport — %s (user-typed endpoint)',
    (id) => {
        const host = entryHost(id);

        it('refuses a 302 to another host without contacting it', async () => {
            const s = useRoutes({
                [host]: {
                    kind: 'redirect',
                    status: 302,
                    toOrigin: METADATA_ORIGIN,
                },
                [METADATA_HOST]: { kind: 'answer' },
            });

            const error = await probeError(settableSlot(id));

            expect(isRedirectRefusal(error)).toBe(true);
            expect(s.hosts).toEqual([host]);
            expect(s.redirectModes).toEqual(['error']);
        });

        it('still succeeds when the endpoint answers 200', async () => {
            const s = useRoutes({ [host]: { kind: 'answer' } });

            const result = await probeSlotCall(settableSlot(id), {
                timeoutMs: PROBE_TIMEOUT_MS,
            });

            expect(result.latencyMs).toBeGreaterThanOrEqual(0);
            expect(new Set(s.hosts)).toEqual(new Set([host]));
            expect(s.redirectModes.every((m) => m === 'error')).toBe(true);
        });
    },
);

/**
 * Fixed endpoints. None of these modules takes the probe's transport, by
 * design (`probe-slot-call.ts`: "fixed-endpoint ones ignore it"): the host is
 * derived by the SDK from a region or location, or pinned by Kodus, so there
 * is no user-typed host for the SSRF gate to vouch for, and a redirect is the
 * provider's own. Pinned as they behave TODAY: the global fetch runs in its
 * default `follow` mode, so a 30x is followed. If one of them starts honoring
 * the probe's transport, the redirect row flips to a refusal and the change
 * gets a reviewer's eye here.
 */
describe('probe transport — fixed endpoints (pinned as today)', () => {
    const KODUS_FIREWORKS_KEY = KODUS_UPSTREAM_KEY_ENV.fireworks;
    let savedKey: string | undefined;

    beforeAll(() => {
        savedKey = process.env[KODUS_FIREWORKS_KEY];
        process.env[KODUS_FIREWORKS_KEY] = 'fw-stub';
    });

    afterAll(() => {
        if (savedKey === undefined) delete process.env[KODUS_FIREWORKS_KEY];
        else process.env[KODUS_FIREWORKS_KEY] = savedKey;
    });

    const SA_JSON = JSON.stringify({
        type: 'service_account',
        project_id: 'stub-project',
        client_email: 'stub@stub-project.iam.gserviceaccount.com',
        private_key: 'unused: google-auth-library is mocked',
    });

    const fixedCases: Array<{
        name: string;
        slot: () => NormalizedModel;
        host: string;
    }> = [
        {
            // Host from the region: bedrock-runtime.<region>.amazonaws.com.
            name: 'amazon_bedrock',
            slot: () =>
                ({
                    ...firstProdRow('amazon_bedrock'),
                    apiKey: '',
                    awsBearerToken: encrypt('bedrock-stub'),
                }) as unknown as NormalizedModel,
            host: `bedrock-runtime.${firstProdRow('amazon_bedrock')!.awsRegion}.amazonaws.com`,
        },
        {
            // Host pinned by Kodus (Fireworks); the org has no say in it.
            name: 'kodus',
            slot: () =>
                ({
                    ...firstProdRow('kodus'),
                    apiKey: '',
                }) as unknown as NormalizedModel,
            host: 'api.fireworks.ai',
        },
        ...rows
            .filter((r) => r.provider === 'google_vertex')
            .filter(
                (r, i, all) => all.findIndex((o) => o.model === r.model) === i,
            )
            .map((r) => ({
                // Host from the location; the global endpoint when unset.
                name: `google_vertex ${r.model}`,
                slot: () =>
                    ({
                        provider: 'google_vertex',
                        model: r.model,
                        apiKey: encrypt(SA_JSON),
                    }) as unknown as NormalizedModel,
                host: 'aiplatform.googleapis.com',
            })),
    ];

    it('keeps the Vertex OAuth exchange in-process', () => {
        expect(MOCKED_GOOGLE_AUTH_COPIES.length).toBeGreaterThan(0);
    });

    it('covers every fixed id', () => {
        const covered = new Set(fixedCases.map((c) => c.name.split(' ')[0]));
        expect([...covered].sort()).toEqual([...FIXED].sort());
    });

    describe.each(fixedCases)('$name', ({ slot, host }) => {
        it('follows a 302 today: the probe transport is not used', async () => {
            const s = useRoutes({
                [host]: {
                    kind: 'redirect',
                    status: 302,
                    toOrigin: METADATA_ORIGIN,
                },
                [METADATA_HOST]: { kind: 'answer' },
            });

            // A 302 on a POST is re-issued as a body-less GET, so the
            // provider's answer from the second host may or may not parse.
            // What is pinned is the transport: no refusal, second host asked.
            const outcome = await probeSlotCall(slot(), {
                timeoutMs: PROBE_TIMEOUT_MS,
            }).then(
                () => 'resolved' as const,
                (error: unknown) => error,
            );

            expect(isRedirectRefusal(outcome)).toBe(false);
            expect(s.redirectModes).not.toContain('error');
            expect(s.hosts).toEqual([host, METADATA_HOST]);
        });

        it('succeeds when the endpoint answers 200', async () => {
            const s = useRoutes({ [host]: { kind: 'answer' } });

            const result = await probeSlotCall(slot(), {
                timeoutMs: PROBE_TIMEOUT_MS,
            });

            expect(result.latencyMs).toBeGreaterThanOrEqual(0);
            expect(new Set(s.hosts)).toEqual(new Set([host]));
        });
    });
});
