/**
 * Deployment gate for the `kodus` BYOK provider ("Kodus as the provider").
 *
 * The provider module is always registered — the registry is deployment-blind
 * — but it only makes sense where Kodus's platform accounts and the credit
 * ledger exist: the cloud. On a self-hosted install the id must not appear in
 * the picker, must not list models or probe, and must not be persisted as a
 * credential. Every org-layer surface asks this ONE function, so the rule is
 * stated once.
 *
 * `API_CLOUD_MODE` is compiled into the EE environment (not read from .env at
 * runtime), which is why this lives outside libs/llm: the kernel must stay free
 * of the EE config.
 */
import { environment } from '@libs/ee/configs/environment';
import { BYOKProvider } from '@libs/llm/model-providers';

export function isKodusProviderAvailable(): boolean {
    return environment.API_CLOUD_MODE === true;
}

/** Whether `providerId` is connectable on THIS deployment. Only the `kodus` id
 *  is gated; every other registered provider is always connectable. */
export function isProviderAvailableHere(providerId: string): boolean {
    return providerId !== BYOKProvider.KODUS || isKodusProviderAvailable();
}
