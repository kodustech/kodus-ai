/**
 * Call sites that pass `error: err.message` (a string) used to crash
 * buildLogObject — `sanitizeString(undefined)` threw "Cannot read properties of
 * undefined (reading 'length')" — and the log fell back to a payload with no
 * cause and no metadata (~530 production events a day).
 */
const { createLogger } = jest.requireActual('@libs/core/log/logger') as {
    createLogger: (component: string) => any;
};

describe('SimpleLogger.buildLogObject — non-Error `error` values', () => {
    const logger = createLogger('logger-string-error-spec');
    const build = (error: unknown) =>
        logger.buildLogObject('svc', { organizationId: 'org-1' }, error);

    it('keeps a string error as the message instead of throwing', () => {
        const obj = build('Request failed with status code 404');

        expect(obj.error).toEqual({
            message: 'Request failed with status code 404',
            stack: undefined,
        });
        expect(obj.metadata).toEqual({ organizationId: 'org-1' });
    });

    it('still redacts secrets inside a string error', () => {
        const obj = build('connect to mongodb://user:hunter2@db/prod failed');

        expect(obj.error.message).not.toContain('hunter2');
    });

    it('does not throw on an object without message or stack', () => {
        expect(() => build({ status: 500 })).not.toThrow();
        expect(build({ status: 500 }).error.message).toBe('{"status":500}');
    });

    it('keeps Error behavior unchanged', () => {
        const obj = build(new Error('real'));

        expect(obj.error.message).toBe('real');
        expect(obj.error.stack).toContain('Error: real');
    });
});
