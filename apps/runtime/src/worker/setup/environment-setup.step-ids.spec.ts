import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { AcquireRequest, Blocked, EnvironmentRuntime } from '@libs/runtime/environment';
import type { FailureBundle } from '@libs/runtime/protocol';
import { type EnvironmentSetupRecord, sealSecret } from '@libs/runtime/run';
import { inferRecipe } from '@libs/runtime/run/recipe-inference';

import { devSealKey } from '../../testing/dev-seal-key';
import { testSetupService } from '../../testing/setup-service';
import type { LlmGateway, LlmRequest } from '../agent/llm-gateway';
import { LlmUnavailableError } from '../agent/llm-gateway';
import type { RecipeAuthorClient, RecipeAuthorOutcome } from '../agent/http-recipe-author';
import type { SetupRepoTokensClient } from '../agent/http-setup-repo-tokens';
import { type SetupExecutionOptions, type SetupOptions, type SetupStepRunner } from './environment-setup.service';
import { InMemoryEnvironmentSetupStore, InMemoryLessonStore } from './testing';

// A setup runs as a DBOS workflow: a resumed workflow replays its steps by id,
// in order (DBOS matches each recorded step by its place and name). So the
// step ids a setup asks for, and their order, are the workflow's durable
// contract: a release that renames, adds or reorders one on a path breaks the
// setups in flight on it. Each path below pins its exact sequence; a replay
// from the recorded steps asks for the same ids and runs none of them again.

const SHA = 'c'.repeat(40);
const REQUESTED_AT = '2026-11-11T12:00:00.000Z';
const KEY = `env-1:${REQUESTED_AT}`;
const LLM_TOKEN = sealSecret('kst1.setup-token', devSealKey(), KEY);
const REPO_TOKEN = sealSecret('ghs_command', devSealKey(), KEY);
const MIN = 60_000;

const REPO_RECIPE = [
    'version: 1',
    'services:',
    '  compose: { files: [compose.yaml], public: app, health: /ready }',
    '  expose:',
    '    - { service: app, port: 3000, kind: http }',
    '',
].join('\n');
const authored = (tag: string) => `version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n# ${tag}\n`;
const FILES = [{ path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n' }];
const inference = { reason: 'no_http_port' as const, message: 'No service in compose.yaml declares an HTTP port Kodus can call.' };

const COMPOSE = 'services:\n  web: { build: ., ports: ["3000"] }\n';
const inferred = inferRecipe({ compose: { path: 'compose.yaml', text: COMPOSE } });
if (inferred.status !== 'inferred') throw new Error('fixture');
const INFERRED = inferred.content;

const cmd = (over: Partial<RuntimeEnvironmentSetupRequested> = {}): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: REQUESTED_AT,
    key: KEY,
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: REPO_RECIPE },
    ...over,
});
/** A default branch with no recipe that Kodus could not infer one for: Kody writes it. */
const kodyWrites = (over: Partial<RuntimeEnvironmentSetupRequested> = {}) =>
    cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null, inference }, llmToken: LLM_TOKEN, ...over });

const bundle = (lines: string[]): FailureBundle => ({
    services: [{ name: 'app', state: 'exited (1)', logTail: lines }],
    ports: [],
    disk: [],
    deniedEgress: [],
    redactions: 0,
    truncated: false,
    collectedAt: '2026-11-11T12:01:00Z',
});
const BUILD_FAILED: Blocked = {
    status: 'blocked',
    blockers: [
        {
            kind: 'toolchain',
            signature: 'compose_up',
            message: 'compose_up: dockergvisor: build app: process "/bin/sh -c go build ./..." did not complete successfully: exit code: 1',
            bundle: bundle(['#12 [app 4/6] RUN go build ./...', 'main.go:3:2: undefined: Handler']),
        },
    ],
    cellId: 'cell-1',
};
const LEARN_LOG = ['> node server.js', 'TypeError: SESSION_STORE_URL is undefined, the session store cannot start'];
const UNKNOWN_FAILURE: Blocked = { status: 'blocked', blockers: [{ kind: 'unknown', signature: 'compose_up', message: 'compose up failed', bundle: bundle(LEARN_LOG) }] };
const DOWNLOAD_401: Blocked = { status: 'blocked', blockers: [{ kind: 'platform', signature: 'repo_fetch', message: 'repo_fetch: tarball: download status 401' }], cellId: 'cell-1' };

type Boot = 'ok' | 'not_ready' | Blocked | 'throws';

/**
 * A cell whose boot of each claim ends as `boot` says for its request (ok by
 * default); with a bake and a pool when asked, and a lease the hub lost when
 * `leaseGone`.
 */
function fakeEnv(o: { boot?: (req: AcquireRequest, token: string) => Boot; bake?: boolean; pool?: boolean; leaseGone?: boolean } = {}) {
    let n = 0;
    const statusOf = new Map<string, number>();
    return (token: string): EnvironmentRuntime => ({
        acquire: async (req) => {
            const boot = o.boot?.(req, token) ?? 'ok';
            if (boot === 'throws') throw new Error('transport lost');
            if (typeof boot === 'object') return boot;
            const claimId = `claim-${++n}`;
            statusOf.set(claimId, boot === 'not_ready' ? 503 : 200);
            return {
                claimId,
                cellId: 'cell-1',
                cellOwner: 'kodus',
                leaseExpiresAt: '',
                hardExpiresAt: '',
                observer: { id: 'obs', state: 'ready' },
                manifest: { expose: [{ service: 'app', port: 3000, kind: 'http' }] },
            } as any;
        },
        probe: async (claimId) => ({ http: { status: statusOf.get(claimId) ?? 200 }, vmHealth: 'ok' }) as any,
        exec: async () => ({}) as any,
        reset: async () => undefined,
        release: async () => undefined,
        ...(o.bake ? { bake: async () => ({ status: 'accepted' as const }) } : {}),
        ...(o.pool ? { poolTarget: async () => ({ status: 'accepted' as const }) } : {}),
        ...(o.leaseGone ? { renew: async () => ({ status: 'gone' as const }) as any } : {}),
    });
}

/** The recipe text's closing comment (`# first`), to boot each of Kody's recipes its own way. */
const tagOf = (req: AcquireRequest) => /# (\w+)\n$/.exec(req.recipe?.content ?? '')?.[1];

const kody = (...answers: RecipeAuthorOutcome[]): RecipeAuthorClient => {
    let calls = 0;
    return { author: async () => answers[Math.min(calls++, answers.length - 1)] };
};
const submitted = (text: string, over: Partial<Extract<RecipeAuthorOutcome, { status: 'submitted' }>> = {}): RecipeAuthorOutcome => ({
    status: 'submitted',
    recipe: text,
    files: FILES,
    notes: 'Builds the app from .kodus/Dockerfile.',
    usage: { inputTokens: 900, outputTokens: 80 },
    ...over,
});
const issuing: SetupRepoTokensClient = {
    refresh: async (req) => ({ status: 'issued', repoToken: sealSecret(`ghs_${req.attempt}`, devSealKey(), KEY) }),
};

class ScriptedLlm implements LlmGateway {
    constructor(private readonly answers: string[]) {}
    async complete(_req: LlmRequest) {
        const next = this.answers.shift();
        if (next === undefined) throw new LlmUnavailableError('no more answers');
        return { text: next, usage: { inputTokens: 10, outputTokens: 5 } };
    }
}

interface Case {
    env: (token: string) => EnvironmentRuntime;
    cmd: RuntimeEnvironmentSetupRequested;
    opts?: SetupOptions;
    execution?: SetupExecutionOptions;
    /** How long after the request the setup's clock starts (a request that waited in the queue). */
    startsAfterMs?: number;
    /** Each boot takes this long on the clock (the wait for room, the hub's queue). */
    bootMs?: number;
    /** What the store holds before the setup: the environment's last setup. */
    previous?: EnvironmentSetupRecord;
}

/** The setup once from the start, then replayed from its recorded steps: the ids each asked for, and the steps the replay ran. */
async function runAndReplay(c: Case) {
    let now = Date.parse(c.cmd.requestedAt) + (c.startsAfterMs ?? 0);
    const store = new InMemoryEnvironmentSetupStore();
    if (c.previous) await store.save(c.previous);
    const env = (token: string) => {
        const e = c.env(token);
        const acquire = e.acquire.bind(e);
        return { ...e, acquire: async (req: AcquireRequest) => ((now += c.bootMs ?? 0), acquire(req)) };
    };
    const svc = testSetupService({ envForSetup: (input) => env(input.sealedRepoToken) }, store, { now: () => new Date(now), ...c.opts });
    // As DBOS records a step: its output, or the error it threw (replayed as thrown).
    const recorded = new Map<string, { out: unknown } | { error: unknown }>();
    let asked: string[] = [];
    let ran = 0;
    const step: SetupStepRunner = async (name, fn) => {
        asked.push(name);
        const seen = recorded.get(name);
        if (seen) {
            if ('error' in seen) throw seen.error;
            return structuredClone(seen.out) as never;
        }
        ran++;
        try {
            const out = await fn();
            recorded.set(name, { out: structuredClone(out) });
            return out;
        } catch (error) {
            recorded.set(name, { error });
            throw error;
        }
    };
    const first = await svc.run(c.cmd, step, undefined, c.execution);
    const firstIds = asked;
    asked = [];
    ran = 0;
    const replay = await svc.run(c.cmd, step, undefined, c.execution);
    return { first, firstIds, replay, replayIds: asked, replayRan: ran };
}

/** `clock:1 record:1 …` written as the run of step ids it is, one string per path. */
const ids = (s: string) => s.trim().split(/\s+/);

/** The environment's last setup: blocked on a build Kodus's catalog reads (a lesson follows a clean boot after it). */
const blockedBefore = (): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    key: 'env-1:2026-11-10T12:00:00.000Z',
    state: 'blocked',
    steps: [],
    blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1', at: '2026-11-10T12:01:00.000Z' }],
    failureBundle: { ...bundle([]), deniedEgress: [{ host: 'registry.npmjs.org', port: 443, at: '2026-11-10T12:00:01Z' }] },
    requestedAt: '2026-11-10T12:00:00.000Z',
    updatedAt: '2026-11-10T12:01:00.000Z',
});

/** The environment's last setup: Kody's recipe, written before the author's instructions were versioned, booted and answered. */
const authoredBefore = (): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    key: 'env-1:2026-11-10T12:00:00.000Z',
    state: 'active',
    refSource: 'default_branch',
    steps: [],
    blockers: [],
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', origin: 'authored', content: authored('old'), digest: 'sha256:old', notes: 'next dev on 3000' },
    requestedAt: '2026-11-10T12:00:00.000Z',
    updatedAt: '2026-11-10T12:01:00.000Z',
});

const CASES: Array<[string, () => Case, string]> = [
    ['a repository recipe that boots, answers, bakes and fills the pool', () => ({ env: fakeEnv({ bake: true, pool: true }), cmd: cmd({ poolSize: 1 }) }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 record:8 clock:17 clock:18 record:9
            health clock:19 clock:20 record:10 clock:21 clock:22 record:11
            bake clock:23 clock:24 record:12 clock:25 clock:26 record:13
            pool clock:27 clock:28 record:14 clock:29 clock:30 record:15
            release clock:31 clock:32 record:16 clock:33 record:17
        `],
    ['the same command delivered again after it ended', () => ({ env: fakeEnv(), cmd: cmd(), previous: { ...blockedBefore(), key: KEY } }), 'load'],
    ['a command refused for its resources before any boot', () => ({ env: fakeEnv(), cmd: cmd({ blocker: { kind: 'resources', message: 'too big' } }) }), 'load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3'],
    ['a setup the admission refused', () => ({ env: fakeEnv(), cmd: cmd(), execution: { admissionBlocker: { kind: 'platform', signature: 'admission:lost', message: 'no room' } } }), 'load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3'],
    ['a command whose ref the product could not resolve', () => ({ env: fakeEnv(), cmd: cmd({ blocker: { kind: 'no_ref', message: 'no default branch' } }) }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 clock:9 record:4 clock:10 record:5
        `],
    ['a command with no commit to build', () => ({ env: fakeEnv(), cmd: cmd({ ref: undefined }) }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 clock:9 record:4 clock:10 record:5
        `],
    ['a recipe the setup refuses before booting it', () => ({ env: fakeEnv(), cmd: cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: 'version: 9\n' } }) }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 clock:13 record:6 clock:14 record:7
        `],
    ['a boot the cell blocks', () => ({ env: fakeEnv({ boot: () => BUILD_FAILED }), cmd: cmd() }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 clock:17 record:8 clock:18 record:9
        `],
    ['an app that never answers its ready check', () => ({ env: fakeEnv({ boot: () => 'not_ready' }), cmd: cmd() }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 record:8 clock:17 clock:18 record:9
            health health:1 health:2 health:3 health:4 health:5 health:6 health:7 health:8 health:9 health:10 health:11 health:12 health:13 health:14 health:15 health:16 health:17 health:18 health:19 health:20 health:21 health:22 health:23 clock:19 clock:20 clock:21 record:10 clock:22 clock:23 record:11
            release clock:24 clock:25 record:12 clock:26 record:13
        `],
    ['a boot that throws', () => ({ env: fakeEnv({ boot: () => 'throws' }), cmd: cmd() }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot clock:15 clock:16 clock:17 record:8 clock:18 record:9
        `],
    ['a claim the hub lost during the ready check', () => ({ env: fakeEnv({ leaseGone: true }), cmd: cmd() }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 record:8 clock:17 clock:18 record:9
            health clock:19 clock:20 clock:21 record:10 clock:22 clock:23 record:11
            release clock:24 clock:25 record:12 clock:26 record:13
        `],
    ['a recipe Kody writes, which boots', () => ({ env: fakeEnv(), cmd: kodyWrites(), opts: { author: kody(submitted(authored('first'))) } }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5
            recipe:author clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 record:8 clock:17 clock:18 record:9
            health clock:19 clock:20 record:10 clock:21 clock:22 record:11 clock:23 clock:24 record:12 clock:25 clock:26 record:13 clock:27 clock:28 record:14 clock:29 clock:30 record:15
            release clock:31 clock:32 record:16 clock:33 record:17
        `],
    ['Kody writes no recipe', () => ({ env: fakeEnv(), cmd: kodyWrites(), opts: { author: kody({ status: 'no_recipe', reason: 'nothing to run', usage: { inputTokens: 1, outputTokens: 1 } } as RecipeAuthorOutcome) } }), `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5
            recipe:author clock:11 clock:12 clock:13 record:6 clock:14 record:7
        `],
    [
        "Kody's recipe whose build fails, repaired once with new download tokens, whose rewrite boots",
        () => ({
            env: fakeEnv({ boot: (req) => (tagOf(req) === 'first' ? BUILD_FAILED : 'ok') }),
            cmd: kodyWrites({ repoToken: REPO_TOKEN }),
            opts: { authorRepairs: 2, author: kody(submitted(authored('first')), submitted(authored('second'))), repoTokens: issuing },
        }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5
            recipe:author clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 clock:17 record:8 clock:18 clock:19 clock:20 record:9
            tokens:repair:1
            recipe:repair:1 clock:21 clock:22 record:10 clock:23 clock:24 record:11
            boot:repair:1
            boot:progress:repair:1 clock:25 clock:26 record:12 clock:27 clock:28 record:13
            health:repair:1 clock:29 clock:30 record:14 clock:31 clock:32 record:15 clock:33 clock:34 record:16 clock:35 clock:36 record:17 clock:37 clock:38 record:18 clock:39 clock:40 record:19
            release:repair:1 clock:41 clock:42 record:20 clock:43 record:21
        `,
    ],
    [
        "Kody's recipe whose every rewrite fails its build, until the setup's repairs run out",
        () => ({
            env: fakeEnv({ boot: () => BUILD_FAILED }),
            cmd: kodyWrites(),
            opts: { authorRepairs: 2, author: kody(submitted(authored('first')), submitted(authored('second')), submitted(authored('third'))) },
        }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5
            recipe:author clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 clock:17 record:8 clock:18 clock:19 clock:20 record:9
            recipe:repair:1 clock:21 clock:22 record:10 clock:23 clock:24 record:11
            boot:repair:1
            boot:progress:repair:1 clock:25 clock:26 clock:27 record:12 clock:28 clock:29 clock:30 record:13
            recipe:repair:2 clock:31 clock:32 record:14 clock:33 clock:34 record:15
            boot:repair:2
            boot:progress:repair:2 clock:35 clock:36 clock:37 record:16 clock:38 record:17
        `,
    ],
    [
        "Kody's recipe whose repair Kody answers with the recipe that failed",
        () => ({ env: fakeEnv({ boot: () => BUILD_FAILED }), cmd: kodyWrites(), opts: { authorRepairs: 2, author: kody(submitted(authored('first'))) } }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5
            recipe:author clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 clock:17 record:8 clock:18 clock:19 clock:20 record:9
            recipe:repair:1 clock:21 clock:22 clock:23 record:10 clock:24 record:11
        `,
    ],
    [
        "the last setup's recipe, written again for a new version of the author's instructions",
        () => ({ env: fakeEnv(), cmd: kodyWrites(), previous: authoredBefore(), opts: { author: kody(submitted(authored('production'))) } }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5
            recipe:reauthor clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 record:8 clock:17 clock:18 record:9
            health clock:19 clock:20 record:10 clock:21 clock:22 record:11 clock:23 clock:24 record:12 clock:25 clock:26 record:13 clock:27 clock:28 record:14 clock:29 clock:30 record:15
            release clock:31 clock:32 record:16 clock:33 record:17
        `,
    ],
    [
        'a request that waited in the queue past its download tokens\' safe life',
        () => ({ env: fakeEnv(), cmd: cmd({ repoToken: REPO_TOKEN, llmToken: LLM_TOKEN }), startsAfterMs: 77 * MIN, opts: { repoTokens: issuing } }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            tokens:boot
            boot
            boot:progress clock:15 clock:16 record:8 clock:17 clock:18 record:9
            health clock:19 clock:20 record:10 clock:21 clock:22 record:11 clock:23 clock:24 record:12 clock:25 clock:26 record:13 clock:27 clock:28 record:14 clock:29 clock:30 record:15
            release clock:31 clock:32 record:16 clock:33 record:17
        `,
    ],
    [
        'a download refused with tokens that expired while the boot waited',
        () => ({
            env: fakeEnv({ boot: (_req, token) => (token === REPO_TOKEN ? DOWNLOAD_401 : 'ok') }),
            cmd: cmd({ repoToken: REPO_TOKEN, llmToken: LLM_TOKEN }),
            startsAfterMs: 40 * MIN,
            bootMs: 21 * MIN,
            opts: { repoTokens: issuing },
        }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15
            tokens:refetch clock:16 clock:17 record:8 clock:18 clock:19 record:9
            boot:refetch
            boot:refetch:progress clock:20 clock:21 record:10 clock:22 clock:23 record:11
            health clock:24 clock:25 record:12 clock:26 clock:27 record:13 clock:28 clock:29 record:14 clock:30 clock:31 record:15 clock:32 clock:33 record:16 clock:34 clock:35 record:17
            release clock:36 clock:37 record:18 clock:38 record:19
        `,
    ],
    [
        'a clean boot after a blocked setup, which records its lesson',
        () => ({
            env: fakeEnv(),
            cmd: cmd(),
            previous: blockedBefore(),
            opts: { lessons: { store: new InMemoryLessonStore(), approvedHosts: async () => ['registry.npmjs.org'] } },
        }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 record:8 clock:17 clock:18 record:9
            health clock:19 clock:20 record:10 clock:21 clock:22 record:11 clock:23 clock:24 record:12 clock:25 clock:26 record:13 clock:27 clock:28 record:14 clock:29 clock:30 record:15
            release clock:31 clock:32 record:16 clock:33 record:17
            lessons
        `,
    ],
    [
        "a blocked inferred recipe Kody's learn loop proves a fix for",
        () => ({
            env: fakeEnv({ boot: (req) => (req.idempotencyKey === `setup:${KEY}` || !req.recipe?.content?.includes('SESSION_STORE_URL') ? UNKNOWN_FAILURE : 'ok') }),
            cmd: cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: INFERRED, origin: 'inferred' }, repoToken: REPO_TOKEN, llmToken: LLM_TOKEN }),
            opts: { learn: { llm: new ScriptedLlm([JSON.stringify({ hypothesis: { kind: 'set_env', name: 'SESSION_STORE_URL' } })]), lessons: new InMemoryLessonStore() }, repoTokens: issuing },
        }),
        `
            load clock:1 clock:2 record:1 clock:3 clock:4 record:2 clock:5 clock:6 record:3 clock:7 clock:8 record:4 clock:9 clock:10 record:5 clock:11 clock:12 record:6 clock:13 clock:14 record:7
            boot
            boot:progress clock:15 clock:16 clock:17 record:8 clock:18 record:9
            learn:lessons
            tokens:learn:1
            learn:llm:1 clock:19 clock:20 record:10
            learn:boot:learn-1
            learn:health:learn-1
            learn:release:learn-1
            tokens:learn:2
            learn:boot:learn-1-replay
            learn:health:learn-1-replay
            learn:release:learn-1-replay clock:21 record:11 clock:22
            learn:lesson
        `,
    ],
];

describe('a setup replayed from its recorded steps asks for the same step ids, in the same order, and runs none again', () => {
    it.each(CASES)('%s', async (_name, arrange, expected) => {
        const r = await runAndReplay(arrange());
        expect(r.firstIds).toEqual(ids(expected));
        expect(new Set(r.firstIds).size).toBe(r.firstIds.length);
        expect(r.replayIds).toEqual(r.firstIds);
        expect(r.replayRan).toBe(0);
        expect(r.replay.state).toBe(r.first.state);
    });
});
