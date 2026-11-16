// What the product remembers about the calls a running setup makes with its
// setup token (Kody's recipe author, fresh download tokens), so that a call
// asked again (the worker's workflow resumed, the API restarted) never runs
// Kody twice nor mints past what the setup's boots could need. Product state,
// in the product Postgres beside the LLM budget; every entry expires with the
// setup token it was asked with.

/** What a recipe-author call answered: the 200 body, or the refusal Kody's run ended in (status and body as sent). */
export type RecipeAuthorOutcome = { status: 200; body: unknown } | { status: number; body: unknown };

/** The budget a run of the author reserved (S-47), kept until it is settled so a run taken over spends it instead of reserving again. */
export interface RecipeAuthorReservation {
    reservationId: string;
    tokens: number;
}

/**
 * Where a (setupKey, attempt) is. `fresh`: nobody asked it before, this call
 * runs Kody. `taken_over`: a call that held it stopped answering past its
 * lease (an API restart mid-run), this call runs Kody again on what that one
 * reserved, if anything. `running`: another call is writing it now. `done`:
 * answered before; `outcome` is the answer. `conflict`: asked before with
 * another body.
 */
export type RecipeAuthorClaim =
    | { state: 'fresh' }
    | { state: 'taken_over'; reservation?: RecipeAuthorReservation }
    | { state: 'running' }
    | { state: 'done'; outcome: RecipeAuthorOutcome }
    | { state: 'conflict' };

export interface RecipeAuthorReceipts {
    /**
     * Takes the attempt for `owner` until `leaseUntil`, atomically: of the
     * calls asking the same key at once, one gets `fresh` (or `taken_over`).
     * `now` is compared with the lease of the call that holds it.
     */
    claim(input: { key: string; fingerprint: string; owner: string; now: Date; leaseUntil: Date; expiresAt: Date }): Promise<RecipeAuthorClaim>;
    /** The budget this owner reserved for the attempt. */
    reserved(key: string, owner: string, reservation: RecipeAuthorReservation): Promise<void>;
    /** The reservation is settled: a call taking the attempt over reserves anew. */
    settled(key: string, owner: string): Promise<void>;
    /** The attempt's answer, once; later calls get it as `done`. */
    complete(key: string, owner: string, outcome: RecipeAuthorOutcome): Promise<void>;
    /** Gives the attempt back with no answer (the call spent nothing): the next call decides again. */
    release(key: string, owner: string): Promise<void>;
}

export const RUNTIME_RECIPE_AUTHOR_RECEIPTS = Symbol.for('RuntimeApi.RecipeAuthorReceipts');

/** A count per key that never passes its max, even across API instances. */
export interface SetupCallCounter {
    /** Counts one call under `key`; false (and nothing counted) when `max` were counted already. */
    take(key: string, max: number, expiresAt: Date): Promise<boolean>;
}

export const RUNTIME_SETUP_CALL_COUNTER = Symbol.for('RuntimeApi.SetupCallCounter');
