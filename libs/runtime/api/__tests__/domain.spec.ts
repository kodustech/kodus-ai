import { RUNTIME_CONTROL_ROUTING_KEY } from '@libs/runtime/run';

import { decideBudget, startOfUtcDay } from '../domain/budget';
import {
    CELL_TOKEN_TTL_MS,
    CellTokenLedger,
    generateCellRegistrationToken,
    hashCellRegistrationToken,
    InMemoryCellTokenStore,
} from '../domain/cell-token';
import { DEFAULT_EGRESS_DENYLIST, deniedBy, InvalidEgressHostError, normalizeEgressHost } from '../domain/egress';
import { evidenceKey, InvalidEvidenceKeyError, signEvidenceUrl, verifyEvidenceSignature } from '../domain/evidence';
import { InvalidRunTokenError, signRunToken, verifyRunToken } from '../domain/run-token';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../domain/runtime-commands';
import { NOW, ORG, SECRET } from './fixtures';

const STEP = '6f1c2b0e-4d3a-4b5c-9d8e-7f6a5b4c3d2e';
const RUN = '0f1c2b0e-4d3a-4b5c-9d8e-7f6a5b4c3d2e';
const claims = { runId: RUN, attempt: 1, organizationId: ORG, teamId: 't', repositoryId: 'r', prNumber: 7, exp: NOW.getTime() / 1000 + 60 };

describe('Run token', () => {
    it('verifies what it signed and refuses tampering, expiry and weak secrets', () => {
        const token = signRunToken(claims, SECRET);
        expect(verifyRunToken(token, SECRET, NOW)).toEqual(claims);

        const [p, body, sig] = token.split('.');
        const forged = Buffer.from(JSON.stringify({ ...claims, organizationId: 'org-b' })).toString('base64url');
        expect(() => verifyRunToken(`${p}.${forged}.${sig}`, SECRET, NOW)).toThrow(InvalidRunTokenError);
        expect(() => verifyRunToken(`${p}.${body}.${sig}`, 'y'.repeat(48), NOW)).toThrow('signature');
        expect(() => verifyRunToken(token, SECRET, new Date(NOW.getTime() + 61_000))).toThrow('expired');
        expect(() => verifyRunToken('nope', SECRET, NOW)).toThrow('malformed');
        expect(() => signRunToken(claims, 'short')).toThrow('at least 32');
    });

    it('refuses a signed token whose claims are malformed (every claim is checked, not only a few)', () => {
        for (const bad of [{ attempt: 'one' }, { teamId: '' }, { maxTokens: -1 }, { extra: true }]) {
            const token = signRunToken({ ...claims, ...bad } as any, SECRET);
            expect(() => verifyRunToken(token, SECRET, NOW)).toThrow('malformed');
        }
    });
});

describe('Evidence URL', () => {
    it('builds the exact key on the server and refuses anything outside the closed sets', () => {
        expect(evidenceKey({ organizationId: ORG, runId: RUN, side: 'pr', stepId: STEP, type: 'har' })).toBe(`${ORG}/${RUN}/pr/${STEP}/har`);
        expect(() => evidenceKey({ organizationId: ORG, runId: RUN, side: 'pr', stepId: '../../other', type: 'har' })).toThrow(InvalidEvidenceKeyError);
        expect(() => evidenceKey({ organizationId: ORG, runId: RUN, side: 'vm', stepId: STEP, type: 'har' })).toThrow('invalid side');
        expect(() => evidenceKey({ organizationId: ORG, runId: RUN, side: 'pr', stepId: STEP, type: 'env' })).toThrow('invalid type');
    });

    it('signs for at most 5 minutes, as an attachment, and the evidence server can verify it', () => {
        const key = `${ORG}/${RUN}/pr/${STEP}/output`;
        const signed = signEvidenceUrl({ baseUrl: 'https://ev.example.test/', key, secret: SECRET, ttlSeconds: 3_600, now: NOW });
        expect(Date.parse(signed.expiresAt) - NOW.getTime()).toBe(300_000);
        const url = new URL(signed.url);
        expect(url.pathname).toBe(`/${key}`);
        // The URL carries exp and sig only: no parameter the server would have to trust.
        expect([...url.searchParams.keys()].sort()).toEqual(['exp', 'sig']);
        const exp = Number(url.searchParams.get('exp'));
        const sig = url.searchParams.get('sig')!;
        expect(verifyEvidenceSignature({ key, exp, sig, secret: SECRET, now: NOW })).toBe(true);
        expect(verifyEvidenceSignature({ key: `${ORG}/other/pr/${STEP}/output`, exp, sig, secret: SECRET, now: NOW })).toBe(false);
        expect(verifyEvidenceSignature({ key, exp, sig, secret: SECRET, now: new Date(NOW.getTime() + 301_000) })).toBe(false);
    });
});

describe('Cell registration token', () => {
    const setup = (now = NOW) => {
        const store = new InMemoryCellTokenStore();
        let t = now;
        const ledger = new CellTokenLedger(store, () => t);
        return { store, ledger, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
    };
    const issue = async (ledger: CellTokenLedger, topology: 'hybrid' | 'self_hosted' = 'hybrid') => {
        const { token, tokenHash } = generateCellRegistrationToken();
        await ledger.record({ tokenHash, organizationId: ORG, topology, expiresAt: new Date(NOW.getTime() + CELL_TOKEN_TTL_MS).toISOString(), issuedBy: 'u' });
        return token;
    };

    it('stores only the hash and redeems once', async () => {
        const { store, ledger } = setup();
        const token = await issue(ledger);
        expect([...store.records.keys()]).toEqual([hashCellRegistrationToken(token)]);
        expect(JSON.stringify([...store.records.values()])).not.toContain(token);
        expect(await ledger.redeem(token, 'hybrid')).toEqual({ ok: true, organizationId: ORG, topology: 'hybrid' });
        expect(await ledger.redeem(token, 'hybrid')).toEqual({ ok: false, reason: 'unknown_or_used' });
    });

    it('refuses after 15 minutes, on another topology, and malformed tokens; a failed attempt still burns it', async () => {
        const a = setup();
        const expired = await issue(a.ledger);
        a.advance(CELL_TOKEN_TTL_MS);
        expect(await a.ledger.redeem(expired, 'hybrid')).toEqual({ ok: false, reason: 'expired' });

        const b = setup();
        const token = await issue(b.ledger, 'self_hosted');
        expect(await b.ledger.redeem(token, 'hybrid')).toEqual({ ok: false, reason: 'topology_mismatch' });
        expect(await b.ledger.redeem(token, 'self_hosted')).toEqual({ ok: false, reason: 'unknown_or_used' });
        expect(await b.ledger.redeem('not-a-token', 'hybrid')).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('Egress host', () => {
    it('normalizes a plain domain and refuses IPs, wildcards and bare names', () => {
        expect(normalizeEgressHost(' Registry.NPMJS.org. ')).toBe('registry.npmjs.org');
        for (const bad of ['10.0.0.1', '169.254.169.254', '[::1]', '*.example.com', 'localhost', 'http://x.com/a', '', 'a..b']) {
            expect(() => normalizeEgressHost(bad)).toThrow(InvalidEgressHostError);
        }
    });

    it('matches the Kodus denylist, wildcards included', () => {
        expect(deniedBy('api.openai.com', DEFAULT_EGRESS_DENYLIST)).toBe('api.openai.com');
        expect(deniedBy('my-bucket.s3.amazonaws.com', DEFAULT_EGRESS_DENYLIST)).toBe('*.s3.amazonaws.com');
        expect(deniedBy('my-bucket.s3.us-east-1.amazonaws.com', DEFAULT_EGRESS_DENYLIST)).toBeDefined();
        expect(deniedBy('abc.trycloudflare.com', DEFAULT_EGRESS_DENYLIST)).toBe('*.trycloudflare.com');
        expect(deniedBy('trycloudflare.com', DEFAULT_EGRESS_DENYLIST)).toBeUndefined();
        expect(deniedBy('registry.npmjs.org', DEFAULT_EGRESS_DENYLIST)).toBeUndefined();
        expect(deniedBy('sqs.us-east-1.amazonaws.com', DEFAULT_EGRESS_DENYLIST)).toBeUndefined();
    });

    it('denies the newer tunnels, request bins and LLM APIs too', () => {
        for (const host of ['abc.ngrok.app', 'x.ngrok-free.dev', 'webhook.site', 'evil.workers.dev', 'raw.githubusercontent.com', 'openrouter.ai', 'my.openai.azure.com', 'bedrock-runtime.us-east-1.amazonaws.com']) {
            expect([host, deniedBy(host, DEFAULT_EGRESS_DENYLIST)]).toEqual([host, expect.any(String)]);
        }
    });
});

describe('Budget', () => {
    const limits = { perRun: 100, perPullRequest: 250, perOrgPerDay: 1_000 };
    it('allows under every limit and names the scope that ran out', () => {
        expect(decideBudget({ run: 10, pullRequest: 10, orgToday: 10 }, limits)).toEqual({ allowed: true, remaining: 90 });
        expect(decideBudget({ run: 100, pullRequest: 100, orgToday: 100 }, limits)).toMatchObject({ allowed: false, exhausted: 'run' });
        expect(decideBudget({ run: 0, pullRequest: 250, orgToday: 0 }, limits)).toMatchObject({ allowed: false, exhausted: 'pull_request' });
        expect(decideBudget({ run: 0, pullRequest: 0, orgToday: 1_000 }, limits)).toMatchObject({ allowed: false, exhausted: 'org_day' });
        expect(decideBudget({ run: 40, pullRequest: 0, orgToday: 0 }, limits, 50)).toEqual({ allowed: true, remaining: 10 });
        expect(decideBudget({ run: 50, pullRequest: 0, orgToday: 0 }, limits, 500)).toEqual({ allowed: true, remaining: 50 });
        expect(startOfUtcDay(new Date('2026-10-29T23:59:00-03:00')).toISOString()).toBe('2026-10-30T00:00:00.000Z');
    });
});

describe('Runtime commands', () => {
    it('builds an outbox row without a job on the control queue and validates the payload', () => {
        const row = runtimeCommandOutboxMessage(
            RuntimeCommandName.StopRequested,
            { scope: 'org', organizationId: ORG, requestedBy: { userId: 'u' }, requestedAt: NOW.toISOString(), correlationId: 'c' },
            'c',
        );
        expect(row.jobId).toBeUndefined();
        // A stop never waits behind a backlog of Run requests.
        expect(row.routingKey).toBe(RUNTIME_CONTROL_ROUTING_KEY);
        expect((row.payload as any).event_name).toBe('runtime.stop.requested');
        expect((row.payload as any).payload.organizationId).toBe(ORG);
        expect(() =>
            runtimeCommandOutboxMessage(RuntimeCommandName.StopRequested, { scope: 'everything' } as any, 'c'),
        ).toThrow();
    });
});
