import {
    isRepositorySpecificSandboxFailure,
    isTimeoutSandboxFailure,
    SandboxCreateCircuitBreaker,
} from './sandbox-create-circuit-breaker';

const OPTIONS = {
    windowMs: 60_000,
    failureThreshold: 3,
    minDistinctOrgs: 2,
    openMs: 30_000,
    probeTimeoutMs: 120_000,
};

/** A create admitted while CLOSED: not the probe. */
const CLOSED_PERMIT = { probe: false };

function makeBreaker() {
    let now = 1_000_000;
    const onTransition = jest.fn();
    const breaker = new SandboxCreateCircuitBreaker(
        OPTIONS,
        () => now,
        onTransition,
    );
    const fail = (...orgs: string[]) =>
        orgs.forEach((org) => breaker.recordFailure(org, CLOSED_PERMIT));
    return {
        breaker,
        onTransition,
        fail,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe('SandboxCreateCircuitBreaker', () => {
    it('opens once the window holds enough failures from enough organizations', () => {
        const { breaker, fail } = makeBreaker();

        fail('org-a', 'org-a');
        expect(breaker.getState()).toBe('CLOSED');

        fail('org-b');
        expect(breaker.getState()).toBe('OPEN');
        expect(breaker.tryAcquire()).toBeNull();
        expect(breaker.remainingOpenMs()).toBe(30_000);
    });

    it('stays closed when every failure comes from one organization, whatever its repos', () => {
        // One tenant whose git host is down fails on all of its repos: that
        // must not turn sandboxes off for every other tenant on the worker.
        const { breaker, fail } = makeBreaker();

        for (let i = 0; i < 10; i++) fail('org-down');

        expect(breaker.getState()).toBe('CLOSED');
        expect(breaker.tryAcquire()).toEqual({ probe: false });
    });

    it('forgets failures older than the window', () => {
        const { breaker, fail, advance } = makeBreaker();

        fail('org-a', 'org-b');
        advance(61_000);
        fail('org-c');

        expect(breaker.getState()).toBe('CLOSED');
    });

    it('lets a single probe through after openMs and closes on success', () => {
        const { breaker, fail, advance } = makeBreaker();
        fail('org-a', 'org-b', 'org-c');

        advance(30_000);
        expect(breaker.getState()).toBe('HALF_OPEN');
        const probe = breaker.tryAcquire()!;
        expect(probe).toMatchObject({ probe: true });
        // Second caller while the probe is in flight is rejected
        expect(breaker.tryAcquire()).toBeNull();

        breaker.recordSuccess(probe);
        expect(breaker.getState()).toBe('CLOSED');
        expect(breaker.tryAcquire()).toEqual({ probe: false });
    });

    it('re-opens when the probe fails', () => {
        const { breaker, fail, advance } = makeBreaker();
        fail('org-a', 'org-b', 'org-c');
        advance(30_000);

        const probe = breaker.tryAcquire()!;
        breaker.recordFailure('org-a', probe);

        expect(breaker.getState()).toBe('OPEN');
        expect(breaker.remainingOpenMs()).toBe(30_000);
    });

    it('frees the probe slot when the probe ends with a repo-specific failure', () => {
        const { breaker, fail, advance } = makeBreaker();
        fail('org-a', 'org-b', 'org-c');
        advance(30_000);

        const probe = breaker.tryAcquire()!;
        breaker.releaseProbe(probe);

        expect(breaker.getState()).toBe('HALF_OPEN');
        expect(breaker.tryAcquire()).toMatchObject({ probe: true });
    });

    it('never lets a create admitted before the trip free or fail the probe', () => {
        const { breaker, fail, advance } = makeBreaker();
        // Admitted while CLOSED, still running when the breaker trips
        const early = breaker.tryAcquire()!;
        fail('org-a', 'org-b', 'org-c');
        advance(30_000);
        const probe = breaker.tryAcquire()!;
        expect(probe).toMatchObject({ probe: true });

        // The early create ends with a repo-specific error, then a timeout
        breaker.releaseProbe(early);
        breaker.recordFailure('org-x', early);

        // Still one probe in flight, and the probe alone decides
        expect(breaker.tryAcquire()).toBeNull();
        expect(breaker.getState()).toBe('HALF_OPEN');
        breaker.recordFailure('org-a', probe);
        expect(breaker.getState()).toBe('OPEN');
    });

    it('ignores a late success from a create admitted before the trip', () => {
        const { breaker, fail, advance } = makeBreaker();
        const early = breaker.tryAcquire()!;
        fail('org-a', 'org-b', 'org-c');

        // Lands while OPEN: the outage is not over
        breaker.recordSuccess(early);
        expect(breaker.getState()).toBe('OPEN');

        // Lands while HALF_OPEN: only the probe decides
        advance(30_000);
        const probe = breaker.tryAcquire()!;
        breaker.recordSuccess(early);
        expect(breaker.getState()).toBe('HALF_OPEN');
        breaker.recordSuccess(probe);
        expect(breaker.getState()).toBe('CLOSED');
    });

    it('replaces a probe that never reports, instead of staying HALF_OPEN for good', () => {
        const { breaker, fail, advance } = makeBreaker();
        fail('org-a', 'org-b', 'org-c');
        advance(30_000);

        expect(breaker.tryAcquire()).toMatchObject({ probe: true });
        advance(119_000);
        expect(breaker.tryAcquire()).toBeNull();
        advance(1_000);
        expect(breaker.tryAcquire()).toMatchObject({ probe: true });
    });

    it('lets only the current probe decide once a stuck one was replaced', () => {
        const { breaker, fail, advance } = makeBreaker();
        fail('org-a', 'org-b', 'org-c');
        advance(30_000);
        const stuck = breaker.tryAcquire()!;
        advance(120_000);
        const live = breaker.tryAcquire()!;
        expect(live).toMatchObject({ probe: true });

        // The replaced probe settles late: it can neither free the live
        // probe's slot nor close or re-open the breaker
        breaker.releaseProbe(stuck);
        expect(breaker.tryAcquire()).toBeNull();
        breaker.recordSuccess(stuck);
        expect(breaker.getState()).toBe('HALF_OPEN');
        breaker.recordFailure('org-a', stuck);
        expect(breaker.getState()).toBe('HALF_OPEN');

        breaker.recordSuccess(live);
        expect(breaker.getState()).toBe('CLOSED');
    });

    it('does not stretch the OPEN window with failures from creates already in flight', () => {
        const { breaker, fail, advance } = makeBreaker();

        fail('org-a', 'org-b', 'org-b');
        expect(breaker.getState()).toBe('OPEN');

        // Creates admitted before the trip fail later, enough of them from
        // enough organizations to trip the breaker again
        advance(20_000);
        fail('org-c', 'org-d', 'org-c');
        advance(10_000);

        // Still openMs after the trip, not after the late failure
        expect(breaker.getState()).toBe('HALF_OPEN');
    });

    it('reports each state change once, with what tripped it', () => {
        const { breaker, onTransition, fail, advance } = makeBreaker();
        const states = () =>
            onTransition.mock.calls.map(([t]) => `${t.from}->${t.to}`);

        breaker.recordSuccess(CLOSED_PERMIT);
        expect(onTransition).not.toHaveBeenCalled();

        fail('org-a', 'org-b', 'org-b');
        expect(onTransition).toHaveBeenLastCalledWith({
            from: 'CLOSED',
            to: 'OPEN',
            failures: 3,
            distinctOrgs: 2,
            openMs: 30_000,
        });

        advance(30_000);
        const probe = breaker.tryAcquire()!;
        breaker.recordFailure('org-c', probe);
        advance(30_000);
        breaker.recordSuccess(breaker.tryAcquire()!);

        expect(states()).toEqual([
            'CLOSED->OPEN',
            'OPEN->HALF_OPEN',
            'HALF_OPEN->OPEN',
            'OPEN->HALF_OPEN',
            'HALF_OPEN->CLOSED',
        ]);
    });

    it('keeps working when the transition callback throws', () => {
        const breaker = new SandboxCreateCircuitBreaker(
            OPTIONS,
            () => 0,
            () => {
                throw new Error('log sink down');
            },
        );

        const logger = { error: jest.fn() };
        (breaker as any).logger = logger;

        breaker.recordFailure('org-a', CLOSED_PERMIT);
        breaker.recordFailure('org-b', CLOSED_PERMIT);
        expect(() =>
            breaker.recordFailure('org-b', CLOSED_PERMIT),
        ).not.toThrow();
        expect(breaker.getState()).toBe('OPEN');
        // The lost transition is still reported
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    from: 'CLOSED',
                    to: 'OPEN',
                    distinctOrgs: 2,
                }),
            }),
        );
    });

    it('falls back to a process warning when the logger is down too', () => {
        const breaker = new SandboxCreateCircuitBreaker(
            OPTIONS,
            () => 0,
            () => {
                throw new Error('log sink down');
            },
        );
        (breaker as any).logger = {
            error: () => {
                throw new Error('logger down');
            },
        };
        const emitWarning = jest
            .spyOn(process, 'emitWarning')
            .mockImplementation(() => undefined);

        try {
            breaker.recordFailure('org-a', CLOSED_PERMIT);
            breaker.recordFailure('org-b', CLOSED_PERMIT);
            breaker.recordFailure('org-b', CLOSED_PERMIT);

            expect(breaker.getState()).toBe('OPEN');
            expect(emitWarning).toHaveBeenCalledWith(
                'SandboxCreateCircuitBreaker: CLOSED -> OPEN transition lost (failures=3, distinctOrgs=2)',
                { code: 'SANDBOX_CIRCUIT_TRANSITION_LOST' },
            );
        } finally {
            emitWarning.mockRestore();
        }
    });

    it('works without a transition callback, and logs nothing', () => {
        const breaker = new SandboxCreateCircuitBreaker(OPTIONS, () => 0);
        const logger = { error: jest.fn() };
        (breaker as any).logger = logger;

        breaker.recordFailure('org-a', CLOSED_PERMIT);
        breaker.recordFailure('org-b', CLOSED_PERMIT);
        breaker.recordFailure('org-b', CLOSED_PERMIT);

        expect(breaker.getState()).toBe('OPEN');
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('a success while CLOSED clears the failures counted so far', () => {
        const { breaker, fail } = makeBreaker();

        fail('org-a', 'org-b');
        breaker.recordSuccess(CLOSED_PERMIT);
        fail('org-a');

        expect(breaker.getState()).toBe('CLOSED');
    });

    it('still counts a failure exactly windowMs old', () => {
        const { breaker, fail, advance } = makeBreaker();

        fail('org-a', 'org-b');
        advance(60_000);
        fail('org-c');

        expect(breaker.getState()).toBe('OPEN');
    });
});

describe('sandbox failure classification', () => {
    it.each([
        'fatal: Authentication failed for https://github.com/org/repo.git',
        "fatal: couldn't find remote ref refs/pull/12/head",
        'remote: Repository not found.',
        'fatal: could not read Username for https://gitlab.com: terminal prompts disabled',
        'The requested URL returned error: 403',
        'HTTP Basic: Access denied',
        'Bitbucket authentication requires a username (app password) or an Atlassian API token, but neither was provided.',
        "fatal: repository 'https://bitbucket.org/acme/app.git/' not found",
        "remote: The project you were looking for could not be found or you don't have permission to view it.",
        'remote: Repository either does not exist or you do not have access.',
    ])('treats "%s" as repository-specific', (message) => {
        expect(isRepositorySpecificSandboxFailure(new Error(message))).toBe(
            true,
        );
    });

    it.each([
        'Command timed out after 120000ms',
        'fatal: unable to access: Failed to connect to 10.0.0.1 port 8388',
        'The requested URL returned error: 502',
        '429: You have reached the maximum number of concurrent E2B sandboxes',
    ])('treats "%s" as an infrastructure failure', (message) => {
        expect(isRepositorySpecificSandboxFailure(new Error(message))).toBe(
            false,
        );
    });

    it('reads stderr from command errors', () => {
        const err = Object.assign(new Error('exit status 128'), {
            stderr: 'fatal: Authentication failed',
        });
        expect(isRepositorySpecificSandboxFailure(err)).toBe(true);
    });

    it('detects timeouts by error name or message', () => {
        const named = new Error('deadline');
        named.name = 'TimeoutError';
        expect(isTimeoutSandboxFailure(named)).toBe(true);
        expect(
            isTimeoutSandboxFailure(new Error('Command timed out after 1ms')),
        ).toBe(true);
        expect(isTimeoutSandboxFailure(new Error('E2B 503'))).toBe(false);
    });
});

describe('sandbox failure classification — inputs', () => {
    it.each([
        'connect timeout',
        'Command timed out',
        'request time out',
        'context deadline exceeded',
    ])('treats "%s" as a timeout', (message) => {
        expect(isTimeoutSandboxFailure(new Error(message))).toBe(true);
    });

    it('treats a TimeoutError by name, and nothing that is not an error object', () => {
        expect(
            isTimeoutSandboxFailure(
                Object.assign(new Error('x'), { name: 'TimeoutError' }),
            ),
        ).toBe(true);
        expect(isTimeoutSandboxFailure('Command timed out')).toBe(false);
        expect(isTimeoutSandboxFailure(undefined)).toBe(false);
    });

    it('reads a repository error from a string, and ignores non-string fields', () => {
        expect(
            isRepositorySpecificSandboxFailure('remote: Repository not found.'),
        ).toBe(true);
        expect(isRepositorySpecificSandboxFailure(undefined)).toBe(false);
        expect(isRepositorySpecificSandboxFailure(404)).toBe(false);
        expect(
            isRepositorySpecificSandboxFailure({
                message: 'exit status 128',
                stderr: { text: 'Repository not found' },
            }),
        ).toBe(false);
    });
});
