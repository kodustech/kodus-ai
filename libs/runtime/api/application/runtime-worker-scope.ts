import {
    ConflictException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { isTerminal } from '@libs/runtime/run';
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
        throw new ForbiddenException('Run token scope mismatch');
    const run = await deps.runs.get(claims.runId, {
        organizationId: claims.organizationId,
    });
    if (!run || run.organizationId !== claims.organizationId)
        throw new NotFoundException('Run not found');
    if (
        run.attempt !== claims.attempt ||
        run.repositoryId !== claims.repositoryId ||
        run.prNumber !== claims.prNumber ||
        run.teamId !== claims.teamId
    )
        throw new ForbiddenException('Run token scope mismatch');
    if (isTerminal(run.state))
        throw new ConflictException('The Run has finished');
    return { claims, run, token };
}
