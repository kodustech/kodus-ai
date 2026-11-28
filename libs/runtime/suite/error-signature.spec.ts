import { errorSignature } from './error-signature';

describe('errorSignature', () => {
    it('is equal for two errors that differ only in a port', () => {
        expect(errorSignature('Error: connect ECONNREFUSED 127.0.0.1:3000')).toBe(errorSignature('Error: connect ECONNREFUSED 127.0.0.1:41873'));
    });
    it('is equal for two timeouts that differ only in the number of milliseconds', () => {
        expect(errorSignature('Timed out retrying after 4000ms: Expected to find element: `.btn`')).toBe(
            errorSignature('Timed out retrying after 5000ms: Expected to find element: `.btn`'),
        );
    });
    it('is equal for errors that differ only in a hash or uuid', () => {
        expect(errorSignature('Request 3f2b9c1e-1111-4222-8333-444455556666 failed (build a1b2c3d4e5f6)')).toBe(
            errorSignature('Request 0aa0bb0b-9999-4888-8777-666655554444 failed (build 9f8e7d6c5b4a)'),
        );
    });
    it('is equal for a selector whose id is generated', () => {
        expect(errorSignature('Expected to find element: #radix-:r1a:-trigger, but never found it')).toBe(
            errorSignature('Expected to find element: #radix-:r9f:-trigger, but never found it'),
        );
        expect(errorSignature('Expected to find element: .css-1x2y3z, but never found it')).toBe(errorSignature('Expected to find element: .css-9q8w7e, but never found it'));
    });
    it('differs for errors that say different things', () => {
        expect(errorSignature('AssertionError: expected 200 to equal 201')).not.toBe(errorSignature('TypeError: x is not a function'));
    });
    it('keeps a stable selector, which is part of what failed', () => {
        expect(errorSignature('Expected to find element: .save-button')).not.toBe(errorSignature('Expected to find element: .cancel-button'));
    });
    it('reads only the first non-empty line', () => {
        expect(errorSignature('\n  \nAssertionError: boom\n    at Context.eval (spec.cy.ts:12:5)')).toBe('AssertionError: boom');
    });
    it('is cut at 200 characters', () => {
        expect(errorSignature('x'.repeat(500))).toHaveLength(200);
    });
    it('is empty for an empty error', () => {
        expect(errorSignature('')).toBe('');
        expect(errorSignature(undefined)).toBe('');
    });
});
