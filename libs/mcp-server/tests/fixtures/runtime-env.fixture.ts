import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEAM_CLI_KEY_SERVICE_TOKEN } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { RuntimeEnvToolsService } from '@libs/runtime/api/application/env-tools.service';
import { RuntimeSetupRequester } from '@libs/runtime/api/application/runtime-setup-requester.service';
import type { ApplyBlockerFixUseCase } from '@libs/runtime/api/application/use-cases/apply-blocker-fix.use-case';
import { EnvironmentViewBuilder } from '@libs/runtime/api/application/use-cases/environments.use-cases';
import type {
    EnvKeyPrincipal,
    ProductEnvironment,
    ProductEnvironmentStore,
    RuntimeApiConfig,
    RuntimeGitPort,
} from '@libs/runtime/api/domain/ports';
import { HttpEnvSessionClient } from '@libs/runtime/api/infrastructure/http-env-session.client';
import { envSessionKeyFrom } from '@libs/runtime/contracts/env-session';
import type {
    EnvironmentRuntime,
    FakeEnvironment,
} from '@libs/runtime/environment';
import { decodeFrame } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { openSecret, sealingKeyFrom } from '@libs/runtime/run/sealed-secret';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { FakeCell } from '../../../../apps/runtime/src/fake-cell/fake-cell';
import { createCa } from '../../../../apps/runtime/src/hub/ca/x509';
import { CellHub } from '../../../../apps/runtime/src/hub/cell-hub';
import { startEnvSessionServer } from '../../../../apps/runtime/src/worker/env-session/env-session-server';
import { EnvSessionService } from '../../../../apps/runtime/src/worker/env-session/env-session.service';
import { EnvMcpController } from '../../controllers/env-mcp.controller';
import { McpAuthGuard } from '../../guards/mcp-auth.guard';
import { McpEnabledGuard } from '../../guards/mcp-enabled.guard';
import { McpEnvTeamKeyGuard } from '../../guards/mcp-env-team-key.guard';
import { EnvMcpServerService } from '../../services/env-mcp-server.service';
import { EnvTools } from '../../tools/env.tools';
import { RUNTIME_RELEASE_GATE } from '@libs/runtime/api/domain/ports';
import { runtimeReleaseGate } from '@libs/runtime/api/__tests__/fixtures';
import { KODUS_MCP_TOKEN_AUDIENCE } from '../../utils/mcp-auth.constants';
import { InMemoryRuntimeEnvAuditStore } from '@libs/runtime/api/testing';
import { InMemoryHubStore } from '../../../../apps/runtime/src/hub/testing';
import { InMemoryEnvSessionStore } from '../../../../apps/runtime/src/worker/env-session/testing';
import { FileEvidenceStore } from '../../../../apps/runtime/src/shared/evidence/file-evidence-store';
import { startEvidenceServer } from '../../../../apps/runtime/src/worker/evidence/evidence-server';
import { evidenceReadUrl } from '../../../../apps/runtime/src/worker/run/run-evidence';

// These credentials have meaning only to the fixture's local key lookup.
export const TEAM_KEY = 'kodus_test_fixture_owner';
export const SHA = 'a'.repeat(40);
export const OWNER: EnvKeyPrincipal = {
    organizationId: 'org-a',
    teamId: 'team-a',
    keyId: 'key-a',
    repositoryIds: ['repo-a', 'repo-blocked'],
    capabilities: ['env:exec', 'env:fix'],
};
const SEAL_KEY = '7'.repeat(64);
const JWT_SECRET = 'fixture-only-mcp-jwt-key-with-no-external-authority';
const RECIPE =
    'version: 1\nservices:\n  compose:\n    files: [compose.yaml]\n    public: web\nvalidate: [{name: Unit tests, run: pnpm test}]\n';

const unexpectedPortCall = (): never => {
    throw new Error('Unexpected infrastructure call in the MCP fixture');
};

export function gate() {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
        finish = resolve;
    });
    return { waiting, finish };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Fixture cleanup timed out')),
                    3000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer!);
    }
}

export async function eventually<T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const value = await read();
        if (accept(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Fixture did not settle within 100 polling attempts');
}

const product = (
    environmentId: string,
    repositoryId: string,
    over: Partial<ProductEnvironment> = {},
): ProductEnvironment => ({
    environmentId,
    repositoryId,
    organizationId: OWNER.organizationId,
    teamId: OWNER.teamId,
    repositoryName: 'fixture/shop',
    state: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
});

const setup = (
    env: ProductEnvironment,
    blocked = false,
): EnvironmentSetupRecord => ({
    environmentId: env.environmentId,
    organizationId: env.organizationId,
    repositoryId: env.repositoryId,
    key: `setup:${env.environmentId}`,
    refSource: 'default_branch',
    sha: SHA,
    state: blocked ? 'blocked' : 'active',
    steps: [],
    blockers: blocked
        ? [
              {
                  kind: 'platform',
                  signature: 'kodus_step',
                  message: 'repo download failed',
                  at: new Date().toISOString(),
              },
          ]
        : [],
    imageId: 'img-mcp-fixture',
    expose: [{ service: 'web', port: 3000, kind: 'http' }],
    recipe: {
        path: '.kodus/workspace.yaml',
        sha: SHA,
        state: 'found',
        content: RECIPE,
    },
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
});

/**
 * Real HTTP/SDK/guards, scoped tools, signed worker listener and cell frames.
 * CellHub↔FakeCell is in process, as in hub-cell.contract.spec.ts: this does
 * not claim to validate TLS, a WebSocket listener, Go or a cloud driver.
 * Only persistence, key/repo/token lookup and the product outbox are local.
 */
export async function runtimeEnvFixture(
    options: { wrongSessionSignature?: boolean; isolatedValidation?:boolean; validationExitCode?:number; loseValidation?:boolean } = {},
) {
    const clients: Client[] = [];
    const pending = new Set<Promise<void>>();
    const errors: unknown[] = [];
    const warnings: string[] = [];
    const gates: Array<ReturnType<typeof gate>> = [];
    let holdAcquire: ReturnType<typeof gate> | undefined;
    let holdExec: ReturnType<typeof gate> | undefined;
    const store = new InMemoryHubStore();
    const hub = new CellHub(
        store,
        new InMemoryRunStreamStore(),
        new RuntimeMetrics(),
        {
            replicaId: 'mcp-fixture',
            replicaUrl: 'http://fixture.invalid',
            ca: createCa('MCP fixture CA'),
            readyTimeoutMs: 1000,
            log: (line) => {
                if (line.level === 'error') errors.push(line.msg);
            },
        },
    );
    const schedule = (work: () => Promise<void>) => {
        const task = new Promise<void>((resolve) => setImmediate(resolve)).then(
            work,
        );
        pending.add(task);
        void task
            .catch((error) => errors.push(error))
            .finally(() => pending.delete(task));
    };
    const scenario: FakeEnvironment = {
        imageId: 'img-mcp-fixture',
        expose: [{ service: 'web', port: 3000, kind: 'http' }],
        exec: () => ({ stdout: 'fixture command completed\n', exitCode:options.validationExitCode ?? 0 }),
    };
    const frames: Array<{ type: string; claimId?: string; body: unknown }> = [];
    let toHub: (frame: string) => Promise<void> = async () => undefined;
    const cell = new FakeCell({
        cellId: 'mcp-fixture-cell',
        owner: 'kodus',
        scenarios: { shop: scenario },
        send: (frame) => schedule(() => {
            if(options.isolatedValidation) {
                const parsed=JSON.parse(frame);
                if(parsed.type==='hello') {parsed.body.driver='docker-gvisor';parsed.body.isolation='sandboxed-container';return toHub(JSON.stringify(parsed));}
            }
            return toHub(frame);
        }),
        log: (line) => errors.push(line),
    });
    const handlers = hub.attach(
        {
            send: (raw) =>
                schedule(async () => {
                    const decoded = decodeFrame(raw);
                    if ('code' in decoded)
                        throw new Error(
                            `Invalid outbound cell frame: ${decoded.code}`,
                        );
                    const message = decoded.message;
                    frames.push({
                        type: message.type,
                        claimId: message.claimId,
                        body: message.body,
                    });
                    if (message.type === 'claim.acquire' && holdAcquire)
                        await holdAcquire.waiting;
                    if(message.type==='exec' && options.loseValidation) {await handlers.onClose();return;}
                    if (message.type === 'exec' && holdExec)
                        await holdExec.waiting;
                    await cell.onFrame(raw);
                }),
            close: () => undefined,
        },
        { cellId: 'mcp-fixture-cell', owner: 'kodus' },
    );
    toHub = (frame) => handlers.onMessage(frame);
    cell.hello();
    await eventually(
        async () => store.sessions.has('mcp-fixture-cell'),
        Boolean,
    );

    const environments = [
        product('shop', 'repo-a'),
        product('blocked', 'repo-blocked'),
        product('foreign-org', 'repo-b', {
            organizationId: 'org-b',
            teamId: 'team-b',
        }),
        product('foreign-team', 'repo-a', { teamId: 'team-b' }),
        product('foreign-repo', 'repo-b'),
    ];
    const setupRecords = new Map(
        environments.map((env) => [
            env.environmentId,
            setup(env, env.environmentId === 'blocked'),
        ]),
    );
    const products: ProductEnvironmentStore = {
        get: async (org: string, id: string) =>
            environments.find(
                (env) => env.organizationId === org && env.environmentId === id,
            ) ?? null,
        findByRepository: async (org: string, repo: string) =>
            environments.find(
                (env) =>
                    env.organizationId === org && env.repositoryId === repo,
            ) ?? null,
        listByOrganization: async (org: string) =>
            environments.filter((env) => env.organizationId === org),
        markSetupRequested: async () => undefined,
        create: unexpectedPortCall,
        updateSettings: unexpectedPortCall,
        markPoolActivity: unexpectedPortCall,
        setPoolApplied: unexpectedPortCall,
        listPoolManagedAcrossOrganizations: unexpectedPortCall,
    };
    const views = new EnvironmentViewBuilder(
        products,
        { list: async () => [] } as never,
        {} as never,
        () => new Date(),
        {
            get: async (org, id) => {
                const record = setupRecords.get(id);
                return record?.organizationId === org ? record : null;
            },
        },
    );
    // env_upload's files: a real store on disk, read back by the cell through the signed evidence server.
    const evidenceDir = mkdtempSync(join(tmpdir(), 'kr-mcp-evidence-'));
    const evidence = new FileEvidenceStore(evidenceDir);
    const evidenceSecret = 'e'.repeat(32);
    const evidenceServer = await startEvidenceServer({ store: evidence, secret: evidenceSecret, host: '127.0.0.1', port: 0 });
    const reads = { baseUrl: `http://127.0.0.1:${(evidenceServer.address() as AddressInfo).port}`, secret: evidenceSecret };
    const sessionStore = new InMemoryEnvSessionStore();
    const worker = new EnvSessionService({
        evidence,
        store: sessionStore,
        setups: { get: async (id) => setupRecords.get(id) ?? null },
        isStopped: async () => false,
        openWaitMs: 1,
        onWarn: (msg) => warnings.push(msg),
        environment: (input): EnvironmentRuntime => {
            const ref = (claimId: string) => ({
                claimId,
                organizationId: input.organizationId,
            });
            return {
                acquire: (req) =>
                    hub.acquire('mcp-fixture-cell', {
                        ...req,
                        expose: input.expose,
                        repo: {
                            provider: 'github',
                            fullName: input.fullName,
                            apiBase: 'https://api.github.com',
                        },
                        repoToken: openSecret(
                            input.sealedRepoToken,
                            sealingKeyFrom(SEAL_KEY),
                            input.tokenBinding,
                        ),
                    }),
                exec: (id, req) => hub.exec(ref(id), req),
                probe: (id, probe, stepId) => hub.probe(ref(id), probe, stepId),
                reset: async (id) => {
                    const result = await hub.reset(ref(id), input.imageId);
                    if ('code' in result) return result;
                },
                release: (id) => hub.release(ref(id)),
                // As HubEnvironmentClient.upload: one signed read URL per file of this org.
                upload: async (id, req) => {
                    const r = await hub.upload(ref(id), { stepId: req.stepId, files: req.files.map((f) => ({ ...f, url: evidenceReadUrl(reads, f.contentRef) })) });
                    if ('code' in r) return r;
                },
            };
        },
    });
    const audit = new InMemoryRuntimeEnvAuditStore();
    const outbox: unknown[] = [];
    const tokenRequests: unknown[] = [];
    const config: RuntimeApiConfig = {
        secretSealKey: SEAL_KEY,
        evidenceTtlSeconds: 300,
        pool: { defaultSize: 0, maxSize: 0 },
        machineSize: { maxPreset: 'large' },
        llmBudget: { perRun: 1000, perPullRequest: 1000, perOrgPerDay: 1000 },
        oncallUserIds: [],
        egressDenylist: [],
        streamLongPollMs: 100,
        streamPollIntervalMs: 10,
    };
    const git: RuntimeGitPort = {
        getDefaultBranchHead: async () => ({
            status: 'ok' as const,
            branch: 'main',
            sha: SHA,
        }),
        readFileAtCommit: async () => RECIPE,
        getPullRequestHead: unexpectedPortCall,
        getPullRequestDiff: unexpectedPortCall,
        resolveGitIdentity: unexpectedPortCall,
        userCanWrite: unexpectedPortCall,
        isOrganizationMember: unexpectedPortCall,
    };
    const tokens = {
        issue: async (repo: unknown) => {
            tokenRequests.push(repo);
            return 'fixture-download-token';
        },
    };
    const requester = new RuntimeSetupRequester(
        products,
        git,
        tokens,
        {
            create: async (row) => {
                outbox.push(row);
                return row;
            },
        } as never,
        () => new Date(),
        config,
    );
    // This fixture chooses the real retry_setup branch, never a recipe PR.
    const noRecipePr = {
        openRecipePullRequest: async () => {
            throw new Error('Fixture forbids Git writes');
        },
    } as unknown as ApplyBlockerFixUseCase;
    const jwt = new JwtService({ secret: JWT_SECRET });
    const keys = new Map<string, EnvKeyPrincipal>([[TEAM_KEY, OWNER]]);
    let app: INestApplication | undefined;
    const sessionServer = await startEnvSessionServer({
        service: worker,
        host: '127.0.0.1',
        port: 0,
        key: envSessionKeyFrom(
            options.wrongSessionSignature
                ? Buffer.alloc(32, 8)
                : sealingKeyFrom(SEAL_KEY),
        ),
    });
    const sessionUrl = `http://127.0.0.1:${(sessionServer.address() as AddressInfo).port}`;
    try {
        const tools = new RuntimeEnvToolsService(
            products,
            views,
            git,
            tokens,
            config,
            new HttpEnvSessionClient({
                baseUrl: sessionUrl,
                secretSealKey: SEAL_KEY,
            }),
            audit,
            requester,
            noRecipePr,
            () => new Date(),
        );
        const module = await Test.createTestingModule({
            controllers: [EnvMcpController],
            providers: [
                EnvTools,
                EnvMcpServerService,
                McpAuthGuard,
                McpEnabledGuard,
                McpEnvTeamKeyGuard,
                { provide: RuntimeEnvToolsService, useValue: tools },
                { provide: RUNTIME_RELEASE_GATE, useValue: runtimeReleaseGate() },
                { provide: JwtService, useValue: jwt },
                {
                    provide: ConfigService,
                    useValue: new ConfigService({
                        API_MCP_SERVER_ENABLED: true,
                        jwtConfig: { secret: JWT_SECRET },
                    }),
                },
                {
                    provide: TEAM_CLI_KEY_SERVICE_TOKEN,
                    useValue: {
                        validateKey: async (key: string) => {
                            const p = keys.get(key);
                            return p
                                ? {
                                      organization: { uuid: p.organizationId },
                                      team: { uuid: p.teamId },
                                      keyId: p.keyId,
                                      config: {
                                          repositoryIds: [...p.repositoryIds],
                                          capabilities: [...p.capabilities],
                                      },
                                  }
                                : null;
                        },
                    },
                },
            ],
        }).compile();
        app = module.createNestApplication({ logger: false });
        await app.listen(0, '127.0.0.1');
    } catch (error) {
        await app?.close();
        sessionServer.closeAllConnections();
        await new Promise<void>((resolve) =>
            sessionServer.close(() => resolve()),
        );
        await handlers.onClose();
        throw error;
    }
    const mcpUrl = `${await app.getUrl()}/mcp/env`;
    return {
        audit,
        outbox,
        tokenRequests,
        worker,
        store,
        sessionStore,
        cell,
        frames,
        errors,
        warnings,
        keys,
        hold(type: 'claim.acquire' | 'exec') {
            const barrier = gate();
            gates.push(barrier);
            if (type === 'claim.acquire') holdAcquire = barrier;
            else holdExec = barrier;
            return barrier.finish;
        },
        async connect(
            token: string | undefined = TEAM_KEY,
            header: 'x-team-key' | 'authorization' = 'x-team-key',
        ) {
            const client = new Client(
                { name: 'kody-runtime-acceptance', version: '1.0.0' },
                { capabilities: {} },
            );
            clients.push(client);
            const headers = token
                ? {
                      [header]:
                          header === 'authorization'
                              ? `Bearer ${token}`
                              : token,
                  }
                : {};
            await client.connect(
                new StreamableHTTPClientTransport(new URL(mcpUrl), {
                    requestInit: { headers },
                }),
            );
            return client;
        },
        serviceToken: () =>
            jwt.signAsync(
                { organizationId: OWNER.organizationId },
                {
                    algorithm: 'HS256',
                    issuer: KODUS_MCP_TOKEN_AUDIENCE,
                    audience: KODUS_MCP_TOKEN_AUDIENCE,
                    expiresIn: 60,
                },
            ),
        async close() {
            const failures: unknown[] = [];
            const cleanup = async (operation: () => Promise<unknown>) => {
                try {
                    await bounded(operation());
                } catch (error) {
                    failures.push(error);
                }
            };
            gates.forEach((barrier) => barrier.finish());
            await cleanup(() => worker.settle());
            for (const row of sessionStore.sessions.values()) {
                await cleanup(() =>
                    worker.close(
                        {
                            organizationId: row.organizationId,
                            teamId: row.teamId,
                            keyId: row.keyId,
                            repositoryIds: [row.repositoryId],
                        },
                        row.sessionId,
                    ),
                );
            }
            await cleanup(() =>
                Promise.all(clients.map((client) => client.close())),
            );
            await cleanup(() => app!.close());
            sessionServer.closeAllConnections();
            await cleanup(
                () =>
                    new Promise<void>((resolve) =>
                        sessionServer.close(() => resolve()),
                    ),
            );
            await cleanup(async () => {
                while (pending.size) await Promise.allSettled([...pending]);
            });
            await cleanup(() => handlers.onClose());
            await cleanup(() => new Promise<void>((resolve) => evidenceServer.close(() => resolve())));
            rmSync(evidenceDir, { recursive: true, force: true });
            if (errors.length || warnings.length || failures.length) {
                throw new AggregateError(
                    [...errors, ...warnings, ...failures],
                    'MCP fixture cleanup/background failure',
                );
            }
        },
    };
}
