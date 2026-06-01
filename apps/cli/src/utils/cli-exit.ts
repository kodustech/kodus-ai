export class CliExitError extends Error {
    constructor(
        public readonly exitCode: number = 1,
        public readonly handled: boolean = true,
        message?: string,
    ) {
        super(message ?? `CLI exited with code ${exitCode}`);
        this.name = 'CliExitError';
    }
}

export function exitWithCode(exitCode: number): never {
    throw new CliExitError(exitCode, true);
}

export function exitWithFailure(message?: string): never {
    throw new CliExitError(1, true, message);
}

export function isCliExitError(error: unknown): error is CliExitError {
    return error instanceof CliExitError;
}

export function isCommanderExitError(
    error: unknown,
): error is { exitCode: number; code: string } {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const candidate = error as { exitCode?: unknown; code?: unknown };
    return (
        typeof candidate.exitCode === 'number' &&
        typeof candidate.code === 'string' &&
        candidate.code.startsWith('commander.')
    );
}
