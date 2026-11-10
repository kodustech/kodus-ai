import type { ModelCallBudget } from '@libs/llm/agent-loop-call';
import type {
    ModelTurnRequest,
    ModelTurnResponse,
} from '@libs/runtime/contracts/model-turn';

export interface RuntimeModelTurnProvider {
    complete(input: {
        organizationId: string;
        teamId: string;
        repositoryId: string;
        runId: string;
        prNumber: number;
        request: ModelTurnRequest;
        maxOutputTokens: number;
        signal?: AbortSignal;
        modelCallBudget: ModelCallBudget;
    }): Promise<{
        generation: ModelTurnResponse['generation'];
        model?: string;
    }>;
}
export interface RuntimeModelTurnReceipts {
    /** Unique insert: a lost/in-flight turn is refused, never silently executed again. */
    claim(
        key: string,
        fingerprint: string,
        expiresAt: Date,
    ): Promise<
        | { fresh: true }
        | { fresh: false; fingerprint: string; response?: ModelTurnResponse }
    >;
    complete(
        key: string,
        fingerprint: string,
        response: ModelTurnResponse,
    ): Promise<void>;
}
export const RUNTIME_MODEL_TURN_PROVIDER = Symbol.for(
    'RuntimeApi.ModelTurnProvider',
);
export const RUNTIME_MODEL_TURN_RECEIPTS = Symbol.for(
    'RuntimeApi.ModelTurnReceipts',
);
