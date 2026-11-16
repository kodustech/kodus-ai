import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { AcquireRequest, Blocked, Claim, EnvironmentRuntime } from '@libs/runtime/environment';
import { sealSecret } from '@libs/runtime/run';

import { devSealKey } from '../../testing/dev-seal-key';
import { testSetupService } from '../../testing/setup-service';
import type { SetupRepoTokensClient, SetupRepoTokensRequestInput } from '../agent/http-setup-repo-tokens';
import { type SetupStepRunner } from './environment-setup.service';
import { InMemoryEnvironmentSetupStore } from './testing';

// The setup command's download tokens are issued when the setup is requested
// and live an hour. A request that waited in the queue longer than that
// (kr-calcom: requested 01:48:07, started 03:04:55) boots with a token the
// cell's download is refused with: the first boot asks the product for new
// ones when the command's are about to run out, and a download refused with
// tokens that had expired boots once more with new ones, instead of ending
// as a platform failure no repair and no retry follows.

const SHA = 'c'.repeat(40);
const REQUESTED_AT = '2026-11-12T01:48:07.000Z';
const KEY = `env-1:${REQUESTED_AT}`;
const LLM_TOKEN = sealSecret('kst1.setup-token', devSealKey(), KEY);
const COMMAND_TOKEN = sealSecret('ghs_command', devSealKey(), KEY);
const FRESH_TOKEN = sealSecret('ghs_fresh', devSealKey(), KEY);
const AGAIN_TOKEN = sealSecret('ghs_again', devSealKey(), KEY);
const MIN = 60_000;

const cmd = (over: Partial<RuntimeEnvironmentSetupRequested> = {}): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'calcom',
    requestedBy: { userId: 'u-1' },
    requestedAt: REQUESTED_AT,
    key: KEY,
    ref: { sha: SHA, branch: 'main' },
    repoToken: COMMAND_TOKEN,
    llmToken: LLM_TOKEN,
    ...over,
});

const DOWNLOAD_401: Blocked = {
    status: 'blocked',
    blockers: [{ kind: 'platform', signature: 'repo_fetch', message: 'repo_fetch: tarball: download status 401' }],
    cellId: 'cell-1',
};
const ready = (n: number): Claim =>
    ({
        claimId: `claim-${n}`,
        cellId: 'cell-1',
        cellOwner: 'kodus',
        leaseExpiresAt: '',
        hardExpiresAt: '',
        observer: { id: 'obs', state: 'ready' },
        manifest: { expose: [{ service: 'app', port: 3000, kind: 'http' }], services: [], imageId: 'setup', seedSha: 's' },
    }) as Claim;

/**
 * A setup whose clock starts `startsAfterMs` after the request; each boot
 * takes `bootMs` (the wait for room, the hub's queue) and its download is
 * refused with 401 for the tokens `refused` names. Records every boot's
 * token and claim key, every step and every token request.
 */
function harness(opts: { startsAfterMs: number; bootMs?: number; refused: string[]; tokens?: SetupRepoTokensClient | null }) {
    let now = Date.parse(REQUESTED_AT) + opts.startsAfterMs;
    const boots: Array<{ token: string; key: string }> = [];
    const steps: string[] = [];
    const asked: SetupRepoTokensRequestInput[] = [];
    let n = 0;
    const envFor = (token: string): EnvironmentRuntime => ({
        acquire: async (req: AcquireRequest) => {
            now += opts.bootMs ?? 0;
            boots.push({ token, key: req.idempotencyKey });
            return opts.refused.includes(token) ? DOWNLOAD_401 : ready(++n);
        },
        probe: async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any,
        exec: async () => ({}) as any,
        reset: async () => undefined,
        release: async () => undefined,
    });
    const answers = [FRESH_TOKEN, AGAIN_TOKEN];
    const tokens: SetupRepoTokensClient =
        opts.tokens ??
        ({
            refresh: async (req) => {
                asked.push(req);
                return { status: 'issued', repoToken: answers[Math.min(asked.length - 1, answers.length - 1)] };
            },
        } satisfies SetupRepoTokensClient);
    const step: SetupStepRunner = (name, fn) => (steps.push(name), fn());
    const store = new InMemoryEnvironmentSetupStore();
    const service = testSetupService({ envForSetup: (input) => envFor(input.sealedRepoToken) }, store, {
        now: () => new Date(now),
        ...(opts.tokens === null ? {} : { repoTokens: tokens }),
    });
    return { run: (over?: Partial<RuntimeEnvironmentSetupRequested>) => service.run(cmd(over), step), boots, steps, asked };
}

const tokenSteps = (steps: string[]) => steps.filter((s) => s.startsWith('tokens:') || s.startsWith('boot'));

describe("a setup's first boot downloads with tokens that are still alive", () => {
    it('a request that waited 77 minutes in the queue asks the product for new tokens and boots with them', async () => {
        const h = harness({ startsAfterMs: 77 * MIN, refused: [COMMAND_TOKEN] });
        const rec = await h.run();

        expect(rec.state).toBe('active');
        expect(h.asked).toEqual([{ organizationId: 'org-1', llmToken: LLM_TOKEN, setupKey: KEY, attempt: 'boot' }]);
        expect(h.boots).toEqual([{ token: FRESH_TOKEN, key: `setup:${KEY}` }]);
        expect(tokenSteps(h.steps)).toEqual(['tokens:boot', 'boot', 'boot:progress']);
    });

    it('a request with less than 15 minutes of its tokens left asks too; one with more boots with the command\'s and asks nothing', async () => {
        const late = harness({ startsAfterMs: 46 * MIN, refused: [] });
        await late.run();
        expect(late.asked.map((a) => a.attempt)).toEqual(['boot']);

        const recent = harness({ startsAfterMs: 44 * MIN, refused: [] });
        const rec = await recent.run();
        expect(rec.state).toBe('active');
        expect(recent.asked).toEqual([]);
        expect(recent.boots.map((b) => b.token)).toEqual([COMMAND_TOKEN]);
        // A recent request's steps are the ones it always had.
        expect(tokenSteps(recent.steps)).toEqual(['boot', 'boot:progress']);
    });

    it('a product that cannot answer leaves the command\'s tokens, as before', async () => {
        const h = harness({ startsAfterMs: 50 * MIN, refused: [], tokens: { refresh: async () => ({ status: 'unavailable', message: 'the product answered 400' }) } });
        const rec = await h.run();
        expect(rec.state).toBe('active');
        expect(h.boots.map((b) => b.token)).toEqual([COMMAND_TOKEN]);
    });
});

describe('a download refused with tokens that had expired', () => {
    it('asks new tokens once and boots again on its own claim, ending active', async () => {
        // Fresh enough when the boot started, expired by the time the cell downloaded (20 minutes waiting for room).
        const h = harness({ startsAfterMs: 40 * MIN, bootMs: 21 * MIN, refused: [COMMAND_TOKEN] });
        const rec = await h.run();

        expect(rec.state).toBe('active');
        expect(rec.blockers).toEqual([]);
        expect(h.asked.map((a) => a.attempt)).toEqual(['boot']);
        expect(h.boots).toEqual([
            { token: COMMAND_TOKEN, key: `setup:${KEY}` },
            { token: FRESH_TOKEN, key: `setup:${KEY}:refetch` },
        ]);
        expect(tokenSteps(h.steps)).toEqual(['boot', 'boot:progress', 'tokens:refetch', 'boot:refetch', 'boot:refetch:progress']);
        const bootSteps = rec.steps.filter((s) => s.name === 'boot');
        expect(bootSteps.map((s) => s.state)).toEqual(['failed', 'done']);
        expect(bootSteps[0].detail).toMatch(/its token had expired; booting again with new tokens/);
        expect(rec.boots?.map((b) => [b.outcome, b.signature])).toEqual([
            ['failed', 'repo_fetch'],
            ['ready', undefined],
        ]);
    });

    it('only once: a second refused download ends the setup on it', async () => {
        const h = harness({ startsAfterMs: 40 * MIN, bootMs: 61 * MIN, refused: [COMMAND_TOKEN, FRESH_TOKEN] });
        const rec = await h.run();

        expect(rec.state).toBe('blocked');
        expect(rec.blockers).toEqual([expect.objectContaining({ kind: 'platform', signature: 'repo_fetch' })]);
        expect(h.asked.map((a) => a.attempt)).toEqual(['boot']);
        expect(h.boots.map((b) => b.token)).toEqual([COMMAND_TOKEN, FRESH_TOKEN]);
    });

    it('a 401 of tokens still in their life (revoked, an installation removed) is the platform failure, with no new tokens and no boot again', async () => {
        const h = harness({ startsAfterMs: 5 * MIN, refused: [COMMAND_TOKEN] });
        const rec = await h.run();

        expect(rec.state).toBe('blocked');
        expect(rec.blockers).toEqual([expect.objectContaining({ kind: 'platform', signature: 'repo_fetch' })]);
        expect(h.asked).toEqual([]);
        expect(h.boots).toHaveLength(1);
    });

    it('a diagnostic hold keeps the refused boot to be looked at', async () => {
        const h = harness({ startsAfterMs: 40 * MIN, bootMs: 21 * MIN, refused: [COMMAND_TOKEN] });
        const rec = await h.run({ diagnosticHold: true });

        expect(rec.state).toBe('blocked');
        expect(h.asked).toEqual([]);
        expect(h.boots).toHaveLength(1);
    });
});
