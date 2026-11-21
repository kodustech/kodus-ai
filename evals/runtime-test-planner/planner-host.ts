import { RuntimeTestPlannerUseCase } from '@libs/runtime/api/application/use-cases/test-planner.use-case';
import { RuntimeModelTurnGatewayUseCase } from '@libs/runtime/api/application/use-cases/model-turn-gateway.use-case';
import { RuntimePlannerSourceUseCase } from '@libs/runtime/api/application/use-cases/planner-source.use-case';
import type {
    RuntimeModelTurnProvider,
    RuntimeModelTurnReceipts,
} from '@libs/runtime/api/domain/model-turn';
import type {
    Clock,
    RunProjectionReader,
    RuntimeAgentRunnerFactory,
    RuntimeApiConfig,
    RuntimeGitPort,
    RuntimeLlmUsageStore,
} from '@libs/runtime/api/domain/ports';
import type { ModelTurnResponse } from '@libs/runtime/contracts/model-turn';
import type { CanaryVault } from '@libs/runtime/canary';
import { WorkerRunPlanClient } from '../../apps/runtime/src/worker/agent/worker-plan-client';
import type { RunPlanClient } from '../../apps/runtime/src/worker/agent/http-run-plan';
import type { SecretOpener } from '../../apps/runtime/src/worker/secrets/sealed-tokens';

/** Data-only receipt storage for one eval process; the product use case owns validation. */
export class MemoryReceipts implements RuntimeModelTurnReceipts {
    private readonly rows = new Map<
        string,
        { fingerprint: string; response?: ModelTurnResponse }
    >();
    get size() {
        return this.rows.size;
    }
    async claim(key: string, fingerprint: string) {
        const old = this.rows.get(key);
        if (old) return { fresh: false as const, ...old };
        this.rows.set(key, { fingerprint });
        return { fresh: true as const };
    }
    async complete(
        key: string,
        fingerprint: string,
        response: ModelTurnResponse,
    ) {
        const row = this.rows.get(key);
        if (!row || row.fingerprint !== fingerprint)
            throw new Error('eval receipt scope mismatch');
        row.response = response;
    }
}

interface Dependencies {
    config: RuntimeApiConfig;
    now: Clock;
    runs: RunProjectionReader;
    usage: RuntimeLlmUsageStore;
    git: RuntimeGitPort;
    runners: RuntimeAgentRunnerFactory;
    provider: RuntimeModelTurnProvider;
    receipts: RuntimeModelTurnReceipts;
    secrets: SecretOpener;
    canaries: CanaryVault;
}

/**
 * Run the production client and production product authority without a network listener.
 * This transport substitutes the HTTP boundary only; source, token, receipt and budget
 * validation remain the real use cases. It never falls through to global fetch.
 */
export function createPlannerClient(
    host: 'worker' | 'product',
    deps: Dependencies,
): RunPlanClient {
    if (host === 'product') {
        const product = new RuntimeTestPlannerUseCase(
            deps.config,
            deps.now,
            deps.runs,
            deps.usage,
            deps.git,
            deps.runners,
        );
        return {
            plan: (call) =>
                product.execute({
                    authorization: `Bearer ${deps.secrets.open(call.runToken, call.runId)}`,
                    body: call.body,
                }),
        };
    }
    if (host !== 'worker') throw new Error('unsupported planner host');
    const gateway = new RuntimeModelTurnGatewayUseCase(
        deps.config,
        deps.now,
        deps.runs,
        deps.usage,
        deps.provider,
        deps.receipts,
    );
    const source = new RuntimePlannerSourceUseCase(
        deps.config,
        deps.now,
        deps.runs,
        deps.git,
    );
    const origin = 'https://runtime-eval.invalid';
    return new WorkerRunPlanClient(origin, {
        secrets: deps.secrets,
        canaries: deps.canaries,
        fetch: async (url, init) => {
            init.signal?.throwIfAborted();
            if (
                init.method !== 'POST' ||
                ![
                    `${origin}/internal/runtime/model-turn`,
                    `${origin}/internal/runtime/planner-source`,
                ].includes(url)
            )
                throw new Error('eval RPC target refused');
            const headers = new Headers(init.headers);
            const input = {
                authorization: headers.get('authorization') ?? undefined,
                body: JSON.parse(String(init.body)),
            };
            try {
                const data = url.endsWith('/model-turn')
                    ? await gateway.execute({
                          ...input,
                          sealedToken:
                              headers.get('x-runtime-sealed-token') ??
                              undefined,
                          signal: init.signal ?? undefined,
                      })
                    : await source.execute(input);
                return new Response(JSON.stringify({ data }), { status: 200 });
            } catch (error) {
                const exception = error as {
                    getStatus?: () => number;
                    getResponse?: () => unknown;
                };
                const status = exception.getStatus?.() ?? 500;
                const response = exception.getResponse?.() as
                    { code?: unknown } | undefined;
                const code =
                    response &&
                    ['llm_budget_exceeded', 'canary_leak'].includes(
                        String(response.code),
                    )
                        ? response.code
                        : 'unavailable';
                return new Response(JSON.stringify({ code }), { status });
            }
        },
    });
}
