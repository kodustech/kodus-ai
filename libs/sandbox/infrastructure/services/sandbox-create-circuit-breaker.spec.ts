import {
    isRepositorySpecificSandboxFailure,
    isTimeoutSandboxFailure,
    SandboxCreateCircuitBreaker,
} from './sandbox-create-circuit-breaker';

const OPTIONS = {
    windowMs: 60_000,
    failureThreshold: 3,
    minDistinctRepos: 2,
    openMs: 30_000,
};

function makeBreaker() {
    let now = 1_000_000;
    const breaker = new SandboxCreateCircuitBreaker(OPTIONS, () => now);
    return {
        breaker,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe('SandboxCreateCircuitBreaker', () => {
    it('opens once the window holds enough failures from enough repos', () => {
        const { breaker } = makeBreaker();

        breaker.recordFailure('org:a');
        breaker.recordFailure('org:a');
        expect(breaker.getState()).toBe('CLOSED');

        breaker.recordFailure('org:b');
        expect(breaker.getState()).toBe('OPEN');
        expect(breaker.tryAcquire()).toBe(false);
        expect(breaker.remainingOpenMs()).toBe(30_000);
    });

    it('stays closed when every failure comes from one repo', () => {
        const { breaker } = makeBreaker();

        for (let i = 0; i < 10; i++) breaker.recordFailure('org:huge');

        expect(breaker.getState()).toBe('CLOSED');
        expect(breaker.tryAcquire()).toBe(true);
    });

    it('forgets failures older than the window', () => {
        const { breaker, advance } = makeBreaker();

        breaker.recordFailure('org:a');
        breaker.recordFailure('org:b');
        advance(61_000);
        breaker.recordFailure('org:c');

        expect(breaker.getState()).toBe('CLOSED');
    });

    it('lets a single probe through after openMs and closes on success', () => {
        const { breaker, advance } = makeBreaker();
        ['org:a', 'org:b', 'org:c'].forEach((r) => breaker.recordFailure(r));

        advance(30_000);
        expect(breaker.getState()).toBe('HALF_OPEN');
        expect(breaker.tryAcquire()).toBe(true);
        // Second caller while the probe is in flight is rejected
        expect(breaker.tryAcquire()).toBe(false);

        breaker.recordSuccess();
        expect(breaker.getState()).toBe('CLOSED');
        expect(breaker.tryAcquire()).toBe(true);
    });

    it('re-opens when the probe fails', () => {
        const { breaker, advance } = makeBreaker();
        ['org:a', 'org:b', 'org:c'].forEach((r) => breaker.recordFailure(r));
        advance(30_000);

        expect(breaker.tryAcquire()).toBe(true);
        breaker.recordFailure('org:a');

        expect(breaker.getState()).toBe('OPEN');
        expect(breaker.remainingOpenMs()).toBe(30_000);
    });

    it('frees the probe slot when the probe ends with a repo-specific failure', () => {
        const { breaker, advance } = makeBreaker();
        ['org:a', 'org:b', 'org:c'].forEach((r) => breaker.recordFailure(r));
        advance(30_000);

        expect(breaker.tryAcquire()).toBe(true);
        breaker.releaseProbe();

        expect(breaker.getState()).toBe('HALF_OPEN');
        expect(breaker.tryAcquire()).toBe(true);
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
