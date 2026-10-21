/**
 * "Does this credential authenticate with Kodus's OWN platform keys?"
 *
 * A `kodus` credential is real BYOK for every plan/routing purpose — the org
 * chose the model, the slot resolves, usage is attributed and billed to the org
 * — but it carries NO auth material of its own: the provider module reads
 * Kodus's upstream keys from env at build time. Four places check "does this
 * credential carry a usable secret?" (slot resolution, status projection, the
 * save-time validator, the connection probe); each of them asks here so the
 * exception lives in one line, not four.
 *
 * Deliberately NOT `managed`: a managed credential normalizes to the env-default
 * path and is skipped by routing; a platform-funded one is routed like any
 * other BYOK slot.
 */
import { BYOKProvider } from './model-providers';

export function isPlatformFundedProvider(
    provider: string | undefined | null,
): boolean {
    return provider === BYOKProvider.KODUS;
}
