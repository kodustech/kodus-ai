import { ServiceUnavailableException } from '@nestjs/common';

import { type SealedSecret, sealingKeyFrom, sealSecret } from '@libs/runtime/run/sealed-secret';

import type { RuntimeApiConfig } from '../domain/ports';

/**
 * Seals a token the product hands the Runtime, bound to the Run (or setup)
 * it belongs to. Without RUNTIME_SECRET_SEAL_KEY nothing is enqueued: a plain
 * token never reaches the outbox, RabbitMQ or a dead-letter copy.
 */
export function sealForRuntime(config: Pick<RuntimeApiConfig, 'secretSealKey'>, plain: string, boundTo: string): SealedSecret {
    if (!config.secretSealKey) {
        throw new ServiceUnavailableException('RUNTIME_SECRET_SEAL_KEY is not configured; the product does not hand the Runtime a plain token');
    }
    return sealSecret(plain, sealingKeyFrom(config.secretSealKey), boundTo);
}
