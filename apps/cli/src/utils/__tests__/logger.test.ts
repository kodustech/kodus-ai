import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    cliDebug,
    cliError,
    cliInfo,
    cliWarn,
    setCliOutputMode,
} from '../logger.js';

describe('logger output modes', () => {
    afterEach(() => {
        delete process.env.KODUS_QUIET;
        delete process.env.KODUS_VERBOSE;
        vi.restoreAllMocks();
    });

    it('suppresses info and warn when quiet mode is enabled', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        setCliOutputMode({ quiet: true, verbose: false });
        cliInfo('hello');
        cliWarn('warn');

        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('always prints errors', () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        setCliOutputMode({ quiet: true, verbose: false });
        cliError('boom');

        expect(errorSpy).toHaveBeenCalledWith('boom');
    });

    it('prints debug only when verbose mode is enabled', () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        setCliOutputMode({ quiet: false, verbose: false });
        cliDebug('first');
        expect(errorSpy).not.toHaveBeenCalled();

        setCliOutputMode({ quiet: false, verbose: true });
        cliDebug('second');
        expect(errorSpy).toHaveBeenCalledWith('second');
    });
});
