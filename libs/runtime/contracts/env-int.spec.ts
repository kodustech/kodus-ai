import { envInteger, envIntOr, requireEnvInt } from './env-int';

describe('envInteger', () => {
    it.each([undefined, '', '  ', '\t\n'])('reads %j as unset', (raw) => {
        expect(envInteger(raw)).toBeUndefined();
    });

    it('trims a padded number', () => {
        expect(envInteger(' 42 ')).toBe(42);
    });

    it.each(['1.5', 'two', '1e400'])('reads %j as not an integer', (raw) => {
        expect(envInteger(raw)).toBeNull();
    });
});

describe('requireEnvInt', () => {
    it('takes the default when the value is blank', () => {
        expect(requireEnvInt('X', '   ', 7, 1)).toBe(7);
    });

    it('stops the boot on a malformed or out-of-range value, naming the variable', () => {
        expect(() => requireEnvInt('X', 'two', 7)).toThrow('X must be an integer >= 0 (got "two")');
        expect(() => requireEnvInt('X', '0', 7, 1)).toThrow('X must be an integer >= 1');
        expect(() => requireEnvInt('X', '6', 7, 0, 5)).toThrow('X must be <= 5');
    });
});

describe('envIntOr', () => {
    it('takes the default for a blank, malformed or too-small value', () => {
        for (const raw of [undefined, '', '  ', 'two', '1.5', '0']) expect(envIntOr(raw, 9, 1)).toBe(9);
    });

    it('takes a valid value, trimmed', () => {
        expect(envIntOr(' 3 ', 9, 1)).toBe(3);
        expect(envIntOr('0', 9, 0)).toBe(0);
    });
});
