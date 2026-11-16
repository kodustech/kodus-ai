import { isSealedSecret, openSecret, sealSecret, type SealedSecret } from '@libs/runtime/run';

// The repo tokens, the Run token and the setup token stay sealed
// (libs/runtime/run/sealed-secret) in every input the workflow engine stores
// and in every log line; they are opened only inside the call that sends them:
// - the claim acquire (repo tokens, handed to the hub over mTLS for the cell's
//   download): env/hub-environment-runtime.ts;
// - product calls with the Run token in the Authorization header:
//   agent/http-llm-gateway.ts (also a setup's learn loop, bound to the setup
//   key), agent/http-run-plan.ts, agent/http-model-turn.ts,
//   agent/worker-plan-client.ts;
// - product calls with the setup token: agent/http-recipe-author.ts and
//   agent/http-setup-repo-tokens.ts, which also opens each repo token it gets
//   back only to check it is bound to the setup.

export const SECRET_OPENER = Symbol('SECRET_OPENER');

export interface SecretOpener {
    /** The plain secret, for the one call that needs it; never store or log the result. */
    open(sealed: string, boundTo: string): string;
}

export class SealedSecretOpener implements SecretOpener {
    constructor(private readonly key: Buffer) {}

    open(sealed: string, boundTo: string): string {
        return openSecret(sealed, this.key, boundTo);
    }

    /** Seals a value for `boundTo` (ingress of a command whose producer did not seal it yet). */
    seal(plain: string, boundTo: string): SealedSecret {
        return sealSecret(plain, this.key, boundTo);
    }
}

/** What a setup's repo token is bound to: the setup command's key, as the product seals it (a setup has no Run). */
export const setupTokenBinding = (setupKey: string) => setupKey;

/** The token as the workflow input keeps it: sealed; a plain one (an older producer) is sealed here, before DBOS stores it. */
export function sealedForInput(token: string | undefined, boundTo: string, opener: SealedSecretOpener): SealedSecret | undefined {
    if (token === undefined || token === '') return undefined;
    return isSealedSecret(token) ? token : opener.seal(token, boundTo);
}
