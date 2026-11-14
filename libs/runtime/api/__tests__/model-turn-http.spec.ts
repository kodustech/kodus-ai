import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { json } from 'express';
import request from 'supertest';
import { RuntimeLlmGatewayController } from '../../../../apps/api/src/controllers/runtime/runtime-llm-gateway.controller';
import { ExceptionsFilter } from '@libs/core/infrastructure/filters/exceptions.filter';
import { RuntimeLlmGatewayUseCase } from '../application/use-cases/llm-gateway.use-case';
import { RuntimeRecipeAuthorUseCase } from '../application/use-cases/recipe-author.use-case';
import { RuntimeTestPlannerUseCase } from '../application/use-cases/test-planner.use-case';
import { RuntimeModelTurnGatewayUseCase } from '../application/use-cases/model-turn-gateway.use-case';
import { RuntimePlannerSourceUseCase } from '../application/use-cases/planner-source.use-case';
import {
    runtimeModelTurnJsonParser,
    runtimePlannerSourceJsonParser,
} from '../infrastructure/worker-rpc-body-parser';
import { sealSecret, sealingKeyFrom } from '@libs/runtime/run';
import { signRunToken } from '../domain/run-token';
import {
    clock,
    config,
    InMemoryLlmUsage,
    NOW,
    OTHER_ORG,
    run,
    SECRET,
    SEAL_KEY,
    storeWith,
} from './fixtures';

jest.mock('@libs/core/infrastructure/config/log/sentry', () => ({
    reportExceptionToSentry: jest.fn(),
}));
async function appFixture(allowModel = false) {
    const r = run({ state: 'testing' }),
        cfg = config(
            allowModel
                ? {
                      llmBudget: {
                          perRun: 100_000,
                          perPullRequest: 200_000,
                          perOrgPerDay: 500_000,
                      },
                  }
                : {},
        );
    const runs = await storeWith(r),
        usage = new InMemoryLlmUsage();
    const rows = new Map<string, any>();
    const receipts = {
        claim: async (key: string, fingerprint: string) => {
            const old = rows.get(key);
            if (old) return { fresh: false as const, ...old };
            rows.set(key, { fingerprint });
            return { fresh: true as const };
        },
        complete: async (key: string, _fp: string, response: unknown) => {
            rows.get(key).response = response;
        },
    };
    const provider = {
        complete: jest.fn(async () => {
            throw Error('provider must not run');
        }),
    };
    const gateway = new RuntimeModelTurnGatewayUseCase(
        cfg,
        clock,
        runs,
        usage,
        provider,
        receipts,
    );
    const git = {
        getPullRequestHead: jest.fn(async () => ({ headSha: r.headSha })),
        getPullRequestDiff: jest.fn(async () => ({
            files: [{ path: 'changed.ts', patch: '+changed' }],
            truncated: false,
        })),
        listFilesAtCommit: jest.fn(async () => ['changed.ts']),
        readFileAtCommit: jest.fn(async () => 'source'),
    };
    const source = new RuntimePlannerSourceUseCase(
        cfg,
        clock,
        runs,
        git as any,
    );
    const module = await Test.createTestingModule({
        controllers: [RuntimeLlmGatewayController],
        providers: [
            { provide: RuntimeLlmGatewayUseCase, useValue: {} },
            { provide: RuntimeRecipeAuthorUseCase, useValue: {} },
            { provide: RuntimeTestPlannerUseCase, useValue: {} },
            { provide: RuntimeModelTurnGatewayUseCase, useValue: gateway },
            { provide: RuntimePlannerSourceUseCase, useValue: source },
        ],
    }).compile();
    const app = module.createNestApplication({ bodyParser: false });
    app.use('/internal/runtime/model-turn', ...runtimeModelTurnJsonParser());
    app.use(
        '/internal/runtime/planner-source',
        ...runtimePlannerSourceJsonParser(),
    );
    app.use(json({ limit: '25mb' }));
    app.useGlobalFilters(new ExceptionsFilter(new ConfigService()));
    await app.init();
    const auth = (patch = {}) =>
        signRunToken(
            {
                runId: r.runId,
                attempt: r.attempt,
                organizationId: r.organizationId,
                teamId: r.teamId,
                repositoryId: r.repositoryId,
                prNumber: r.prNumber,
                exp: NOW.getTime() / 1000 + 3600,
                ...patch,
            },
            SECRET,
        );
    const token = auth(),
        sealed = sealSecret(token, sealingKeyFrom(SEAL_KEY), r.runId);
    const body = {
        v: 1,
        scope: { runId: r.runId, attempt: 1, turnId: randomUUID() },
        task: 'runtime.plan',
        toolset: 'runtime-planner-v1',
        call: {
            tools: [],
            prompt: [
                {
                    role: 'user',
                    content: [{ type: 'text', text: 'x'.repeat(4000) }],
                },
            ],
            maxOutputTokens: 20,
        },
    };
    return { app, r, auth, token, sealed, body, provider, git };
}
describe('worker RPC real controller/filter boundary', () => {
    it('retains the budget machine code through the production exception filter', async () => {
        const h = await appFixture();
        try {
            const out = await request(h.app.getHttpServer())
                .post('/internal/runtime/model-turn')
                .set('Authorization', `Bearer ${h.token}`)
                .set('x-runtime-sealed-token', h.sealed)
                .send(h.body)
                .timeout({ deadline: 3000 });
            expect(out.status).toBe(429);
            expect(out.body.code).toBe('llm_budget_exceeded');
            expect(h.provider.complete).not.toHaveBeenCalled();
        } finally {
            await h.app.close();
        }
    });
    it('authenticates before interpreting frames and refuses another org at the source HTTP endpoint', async () => {
        const h = await appFixture();
        try {
            const bad = await request(h.app.getHttpServer())
                .post('/internal/runtime/model-turn')
                .set('Authorization', 'Bearer invalid')
                .send({ invalid: true })
                .timeout({ deadline: 3000 });
            expect(bad.status).toBe(401);
            const source = await request(h.app.getHttpServer())
                .post('/internal/runtime/planner-source')
                .set(
                    'Authorization',
                    `Bearer ${h.auth({ organizationId: OTHER_ORG })}`,
                )
                .send({
                    v: 1,
                    scope: { runId: h.r.runId, attempt: 1 },
                    op: 'context',
                })
                .timeout({ deadline: 3000 });
            expect(source.status).toBe(404);
            expect(h.git.getPullRequestHead).not.toHaveBeenCalled();
        } finally {
            await h.app.close();
        }
    });
});

it('serves one scoped source read and model turn through real HTTP parsers/controller/filter, then replays the persisted receipt without another provider call', async () => {
    const h = await appFixture(true);
    h.provider.complete.mockImplementation(async (input: any) => {
        const lease = await input.modelCallBudget.before({
            prompt: input.request.call.prompt,
            tools: input.request.call.tools,
            maxOutputTokens: input.maxOutputTokens,
        });
        await lease.finish({
            outcome: 'completed',
            usage: { inputTokens: { total: 20 }, outputTokens: { total: 4 } },
        });
        return {
            generation: {
                content: [{ type: 'text', text: 'safe response' }],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                    reported: true,
                    inputTokens: { total: 20 },
                    outputTokens: { total: 4 },
                },
                warnings: [],
            },
        } as never;
    });
    try {
        const source = await request(h.app.getHttpServer())
            .post('/internal/runtime/planner-source')
            .set('Authorization', `Bearer ${h.token}`)
            .send({
                v: 1,
                scope: { runId: h.r.runId, attempt: 1 },
                op: 'read',
                side: 'head',
                path: 'changed.ts',
                maxBytes: 1024,
            })
            .timeout({ deadline: 3000 });
        expect(source.status).toBe(200);
        expect(JSON.stringify(source.body)).toContain('source');
        const call = () =>
            request(h.app.getHttpServer())
                .post('/internal/runtime/model-turn')
                .set('Authorization', `Bearer ${h.token}`)
                .set('x-runtime-sealed-token', h.sealed)
                .send(h.body)
                .timeout({ deadline: 3000 });
        const one = await call(),
            two = await call();
        expect(one.status).toBe(200);
        expect(two.body).toEqual(one.body);
        expect(h.provider.complete).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(one.body)).not.toContain(h.token);
        expect(JSON.stringify(one.body)).not.toContain(h.sealed);
    } finally {
        await h.app.close();
    }
});
