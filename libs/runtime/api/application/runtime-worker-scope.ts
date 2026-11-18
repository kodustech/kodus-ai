import {
    ForbiddenException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import {
    InvalidRunTokenError,
    isSetupToken,
    verifyRunToken,
} from '../domain/run-token';
import type {
    Clock,
    RunProjectionReader,
    RuntimeApiConfig,
} from '../domain/ports';
import { liveRunFor } from './llm-run-budget';

const SCOPE_MISMATCH = 'Run token scope mismatch';

export function verifyRuntimeWorkerToken(
    config: RuntimeApiConfig,
    now: Clock,
    authorization: string | undefined,
) {
    if (!config.runTokenSecret)
        throw new ServiceUnavailableException(
            'Runtime gateway is not configured',
        );
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token || isSetupToken(token))
        throw new UnauthorizedException('Run token required');
    let claims: ReturnType<typeof verifyRunToken>;
    try {
        claims = verifyRunToken(token, config.runTokenSecret, now());
    } catch (e) {
        if (e instanceof InvalidRunTokenError)
            throw new UnauthorizedException('Invalid Run token');
        throw e;
    }
    return { claims, token };
}

/** Product scope is rechecked on every RPC, including cached model-turn receipts. */
export async function runtimeWorkerScope(
    deps: { config: RuntimeApiConfig; now: Clock; runs: RunProjectionReader },
    authorization: string | undefined,
    scope: { runId: string; attempt: number },
) {
    const { claims, token } = verifyRuntimeWorkerToken(
        deps.config,
        deps.now,
        authorization,
    );
    if (scope.runId !== claims.runId || scope.attempt !== claims.attempt)
        throw new ForbiddenException(SCOPE_MISMATCH);
    const run = await liveRunFor(deps.runs, claims, claims.runId, {
        mismatch: SCOPE_MISMATCH,
        sameAs: ['repositoryId', 'prNumber', 'teamId'],
    });
    return { claims, run, token };
}
