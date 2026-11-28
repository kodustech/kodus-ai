import { safeFailure } from './failure';

describe('safe failure classification', () => {
    it.each([
        ['ETIMEDOUT', 'timeout'],
        ['ECONNABORTED', 'timeout'],
        ['ABORT_ERR', 'cancelled'],
        ['ECONNRESET', 'network'],
        ['ECONNREFUSED', 'network'],
        ['ENOTFOUND', 'network'],
        ['EAI_AGAIN', 'network'],
        ['EPIPE', 'network'],
        ['EACCES', 'permission_denied'],
        ['EPERM', 'permission_denied'],
        ['ERR_INVALID_ARG_TYPE', 'invalid_input'],
    ])('classifies known %s without retaining the exception', (code, kind) => {
        expect(
            safeFailure(
                Object.assign(new Error('not diagnostic data'), { code }),
            ),
        ).toEqual({ kind, code });
    });
    it('does not echo arbitrary codes, messages, names or causes', () => {
        for (const error of [
            'private',
            { code: 'private', name: 'private', cause: 'private' },
            null,
            { code: '__proto__' },
        ]) {
            expect(safeFailure(error)).toEqual({ kind: 'unexpected' });
        }
        expect(
            safeFailure(
                Object.assign(new Error('private'), { name: 'AbortError' }),
            ),
        ).toEqual({ kind: 'cancelled' });
        expect(
            safeFailure(
                Object.assign(new Error('private'), { name: 'TimeoutError' }),
            ),
        ).toEqual({ kind: 'timeout' });
        expect(safeFailure(new TypeError('private'))).toEqual({
            kind: 'invalid_input',
        });
    });
    it('never executes code/message getters or a revoked proxy', () => {
        const getter = jest.fn(() => {
            throw new Error('getter');
        });
        const error = Object.defineProperties(
            {},
            { code: { get: getter }, message: { get: getter } },
        );
        expect(safeFailure(error)).toEqual({ kind: 'unexpected' });
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        expect(safeFailure(proxy)).toEqual({ kind: 'unexpected' });
        expect(getter).not.toHaveBeenCalled();
    });
    it('preserves a previously sanitized category at a second diagnostic boundary', () => {
        for (const name of ['AbortError', 'TimeoutError']) {
            const once = safeFailure(
                Object.assign(new Error('private'), { name }),
            );
            expect(safeFailure(once)).toEqual(once);
        }
    });
});
