import { describe, expect, it } from 'vitest';
import {
    assertStructuredOutputForFields,
    parseCsvEnumList,
    parseOptionalNumber,
    validateHttpUrl,
} from '../input-validation.js';

describe('input validation', () => {
    it('parses optional number', () => {
        expect(parseOptionalNumber(undefined, '--pr-number')).toBeUndefined();
        expect(parseOptionalNumber('42', '--pr-number')).toBe(42);
    });

    it('throws on invalid number', () => {
        expect(() => parseOptionalNumber('abc', '--pr-number')).toThrow(
            'Invalid --pr-number value',
        );
    });

    it('throws on non-integer or non-positive number', () => {
        expect(() => parseOptionalNumber('1.2', '--pr-number')).toThrow(
            'Invalid --pr-number value',
        );
        expect(() => parseOptionalNumber('0', '--pr-number')).toThrow(
            'Invalid --pr-number value',
        );
        expect(() => parseOptionalNumber('-2', '--pr-number')).toThrow(
            'Invalid --pr-number value',
        );
    });

    it('validates csv enum list', () => {
        const result = parseCsvEnumList('error,warning', '--severity', [
            'info',
            'warning',
            'error',
            'critical',
        ]);
        expect(result).toEqual(['error', 'warning']);
    });

    it('throws when csv enum contains invalid values', () => {
        expect(() =>
            parseCsvEnumList('error,banana', '--severity', [
                'info',
                'warning',
                'error',
                'critical',
            ]),
        ).toThrow('Invalid value for --severity');
    });

    it('validates http/https URL', () => {
        expect(
            validateHttpUrl('https://github.com/test/repo', '--pr-url'),
        ).toBe('https://github.com/test/repo');
    });

    it('throws for invalid URL', () => {
        expect(() => validateHttpUrl('file:///tmp/x', '--pr-url')).toThrow(
            'Invalid --pr-url value',
        );
    });

    it('rejects --fields when output is non-structured and not agent', () => {
        expect(() =>
            assertStructuredOutputForFields({
                fields: 'summary',
                format: 'terminal',
                isAgent: false,
            }),
        ).toThrow('--fields requires --format json or --agent');
    });
});
