interface CliOutputMode {
    quiet?: boolean;
    verbose?: boolean;
}

export function isCliQuietMode(): boolean {
    return process.env.KODUS_QUIET === '1';
}

export function isCliVerboseMode(): boolean {
    return (
        process.env.KODUS_VERBOSE === '1' ||
        process.env.KODUS_VERBOSE === 'true'
    );
}

export function setCliOutputMode(mode: CliOutputMode): void {
    if (mode.quiet !== undefined) {
        if (mode.quiet) {
            process.env.KODUS_QUIET = '1';
        } else {
            delete process.env.KODUS_QUIET;
        }
    }

    if (mode.verbose !== undefined) {
        if (mode.verbose) {
            process.env.KODUS_VERBOSE = '1';
        } else {
            delete process.env.KODUS_VERBOSE;
        }
    }
}

export function cliInfo(...args: unknown[]): void {
    if (isCliQuietMode()) {
        return;
    }
    console.log(...args);
}

export function cliWarn(...args: unknown[]): void {
    if (isCliQuietMode()) {
        return;
    }
    console.warn(...args);
}

export function cliError(...args: unknown[]): void {
    console.error(...args);
}

export function cliDebug(...args: unknown[]): void {
    if (isCliQuietMode() || !isCliVerboseMode()) {
        return;
    }
    // Keep stdout clean for machine-readable formats (json/markdown).
    console.error(...args);
}
