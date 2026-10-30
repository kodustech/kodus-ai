import type { BYOKConfig, BYOKCredential } from "../_types";

/**
 * Which model a credential's connection test should be sent to.
 *
 * The screen used the first entry of `models[]` that referenced the credential —
 * array order, which is insertion order in the stored blob. Nobody chose it and
 * the screen never showed it, so the test meant something different for every
 * org by accident.
 *
 * That is not a cosmetic problem: the rotate screen REFUSES to save when the
 * probe fails, so an arbitrary pick can hold a key rotation hostage to a model
 * the org no longer runs — which is exactly what happened to a customer who
 * could not replace a key because the accidental pick was a model their new
 * provider account had no route to. It fails the other way too: passing on the
 * first model says nothing about the one that actually serves reviews.
 *
 * So probe what routing actually runs — the org default, then the fallback —
 * and keep array order only as a last resort. A routing id that points at
 * another credential's model is ignored: it would test a different key.
 */
export const pickProbeModel = (
    config: BYOKConfig | null | undefined,
    credential: BYOKCredential | undefined,
): string | undefined => {
    if (!credential) return undefined;

    const mine = (config?.models ?? []).filter(
        (m) => m.credentialId === credential.id,
    );
    const byId = (id?: string) =>
        id ? mine.find((m) => m.id === id) : undefined;
    const routing = config?.routing;

    return (
        byId(routing?.defaultModelId) ??
        byId(routing?.fallbackModelId) ??
        mine[0]
    )?.model;
};
