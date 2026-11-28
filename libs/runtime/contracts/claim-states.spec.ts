import {
    assertClaimTransition,
    canClaimTransition,
    CLAIM_STATES,
    type ClaimState,
    claimStatesInto,
    InvalidClaimTransitionError,
    isClaimStateIn,
    isFinalClaimState,
    LIVE_CLAIM_STATES,
    MACHINE_HOLDING_CLAIM_STATES,
    OPEN_CLAIM_STATES,
    REBINDABLE_CLAIM_STATES,
    REVOCATION_TERMINATED_CLAIM_STATES,
} from './enums';

describe('claim transitions', () => {
    // Every legal edge, with the hub path that takes it. Any pair not listed here is refused.
    const LEGAL: Array<[ClaimState, ClaimState, string]> = [
        ['pending', 'pending', 'a retry of a pending claim starts a new acquire round on the cell of the retry'],
        ['pending', 'bound', 'claim.ready binds a pending claim'],
        ['pending', 'held', 'a failed setup boot that asked for a diagnostic hold keeps its machines'],
        ['pending', 'blocked', 'the cell refuses or blocks the claim.acquire'],
        ['pending', 'failed', 'the boot fails, is never answered, or never reports ready'],
        ['pending', 'compromised', 'the cell reports a security violation during the boot'],
        ['pending', 'released', 'the worker releases a claim still booting'],
        ['pending', 'terminated', 'the cell is revoked while the claim boots'],
        ['bound', 'pending', 'a retry of a bound claim (the cell was lost) starts a new round'],
        ['bound', 'compromised', 'the cell reports a security violation on a bound claim'],
        ['bound', 'released', 'the worker releases a bound claim'],
        ['bound', 'terminated', 'the cell of a bound claim is revoked'],
        ['held', 'pending', 'a retry of a held claim starts a new round'],
        ['held', 'compromised', 'the cell reports a security violation on a held claim'],
        ['held', 'released', 'the worker releases a held claim'],
        ['held', 'terminated', 'the cell of a held claim is revoked'],
        ['blocked', 'pending', 'a retry of a blocked claim (no room on the cell) starts a new round'],
        ['blocked', 'released', 'the worker releases a blocked claim'],
        ['blocked', 'terminated', 'the cell of a blocked claim is revoked'],
        ['failed', 'pending', 'a retry of a failed claim starts a new round'],
        ['failed', 'released', 'the worker releases a failed claim'],
        ['failed', 'terminated', 'the cell of a failed claim is revoked'],
        ['compromised', 'released', 'the end of the Run releases a compromised claim, its evidence kept until then'],
    ];

    it.each(LEGAL)('allows %s -> %s: %s', (from, to) => {
        expect(canClaimTransition(from, to)).toBe(true);
        expect(() => assertClaimTransition([from], to)).not.toThrow();
    });

    const illegal = CLAIM_STATES.flatMap((from) => CLAIM_STATES.filter((to) => !LEGAL.some(([f, t]) => f === from && t === to)).map((to) => [from, to] as const));

    it.each(illegal)('refuses %s -> %s', (from, to) => {
        expect(canClaimTransition(from, to)).toBe(false);
        expect(() => assertClaimTransition([from], to)).toThrow(InvalidClaimTransitionError);
    });

    it('refuses to move a compromised claim anywhere but released: it is never rebound, bound again or terminated by a revocation', () => {
        expect(CLAIM_STATES.filter((to) => canClaimTransition('compromised', to))).toEqual(['released']);
    });

    it('refuses every move out of a final state', () => {
        for (const final of ['released', 'terminated'] as const) expect(CLAIM_STATES.filter((to) => canClaimTransition(final, to))).toEqual([]);
    });

    it('refuses a guarded move when any one of its start states may not reach the target, naming that state', () => {
        expect(() => assertClaimTransition(['pending', 'bound'], 'failed')).toThrow('invalid claim transition bound -> failed');
        expect(() => assertClaimTransition(['pending'], 'failed')).not.toThrow();
    });

    it('lists the states that may reach a target in CLAIM_STATES order', () => {
        expect(claimStatesInto('compromised')).toEqual(['pending', 'bound', 'held']);
        expect(claimStatesInto('bound')).toEqual(['pending']);
    });
});

describe('claim state sets', () => {
    it('an open state is every state but the two final ones', () => {
        expect(OPEN_CLAIM_STATES).toEqual(['pending', 'bound', 'held', 'blocked', 'failed', 'compromised']);
        expect(OPEN_CLAIM_STATES).toEqual(CLAIM_STATES.filter((s) => !isFinalClaimState(s)));
    });

    it('a live claim takes steps; a compromised one still holds its machines but takes none', () => {
        expect(LIVE_CLAIM_STATES).toEqual(['pending', 'bound', 'held']);
        expect(MACHINE_HOLDING_CLAIM_STATES).toEqual([...LIVE_CLAIM_STATES, 'compromised']);
    });

    it('only a live claim can be compromised', () => {
        expect(claimStatesInto('compromised')).toEqual(LIVE_CLAIM_STATES);
    });

    it('a new acquire round rebinds every open claim but a compromised one', () => {
        expect(REBINDABLE_CLAIM_STATES).toEqual(['pending', 'bound', 'held', 'blocked', 'failed']);
    });

    it('a revocation terminates every open claim but a compromised one, kept as evidence', () => {
        expect(REVOCATION_TERMINATED_CLAIM_STATES).toEqual(['pending', 'bound', 'held', 'blocked', 'failed']);
        expect(REVOCATION_TERMINATED_CLAIM_STATES).toEqual(OPEN_CLAIM_STATES.filter((s) => s !== 'compromised'));
    });

    it('isClaimStateIn reads a state stored as text', () => {
        expect(isClaimStateIn(LIVE_CLAIM_STATES, 'bound')).toBe(true);
        expect(isClaimStateIn(LIVE_CLAIM_STATES, 'compromised')).toBe(false);
        expect(isClaimStateIn(LIVE_CLAIM_STATES, 'not-a-state')).toBe(false);
    });
});
