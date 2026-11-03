/**
 * Global mock for the `e2b` package.
 *
 * The real `e2b` package transitively depends on `chalk` v5+ which is ESM-only.
 * Jest (CommonJS) cannot parse the ESM `import` statement, causing:
 *   SyntaxError: Cannot use import statement outside a module
 *
 * This mock is wired via `moduleNameMapper` in jest.config.ts so that
 * Jest never attempts to resolve or parse the real package.
 *
 * All static Sandbox methods used by SandboxLeaseManager and SandboxLeaseReaperService
 * are stubbed here so tests can spy on them via jest.spyOn(Sandbox, 'kill') etc.
 */
export const Sandbox = {
    create: jest.fn().mockResolvedValue({}),
    connect: jest.fn().mockResolvedValue({}),
    kill: jest.fn().mockResolvedValue(undefined),
    setTimeout: jest.fn().mockResolvedValue(undefined),
    list: jest.fn(),
};

/** Same hierarchy and name as the SDK's, so `instanceof` checks hold. */
export class SandboxError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'SandboxError';
    }
}

export class RateLimitError extends SandboxError {
    constructor(message?: string) {
        super(message);
        this.name = 'RateLimitError';
    }
}
