import {
    cweUrl,
    describeCwe,
    normalizeCwe,
} from '@libs/code-review/infrastructure/agents/core/security-finding';

describe('normalizeCwe', () => {
    it('canonicalizes the shapes models actually emit', () => {
        expect(normalizeCwe('CWE-89')).toBe('CWE-89');
        expect(normalizeCwe('cwe89')).toBe('CWE-89');
        expect(normalizeCwe('cwe 89')).toBe('CWE-89');
        expect(normalizeCwe('CWE_89')).toBe('CWE-89');
        expect(normalizeCwe('CWE-89: SQL Injection')).toBe('CWE-89');
        expect(normalizeCwe('see CWE-22 for details')).toBe('CWE-22');
    });

    it('strips leading zeros so ids dedupe', () => {
        expect(normalizeCwe('CWE-089')).toBe('CWE-89');
    });

    it('returns undefined instead of throwing on junk — a missing CWE must never kill a finding', () => {
        expect(normalizeCwe(undefined)).toBeUndefined();
        expect(normalizeCwe(null)).toBeUndefined();
        expect(normalizeCwe('')).toBeUndefined();
        expect(normalizeCwe('SQL Injection')).toBeUndefined();
        expect(normalizeCwe(42 as unknown as string)).toBeUndefined();
    });
});

describe('describeCwe', () => {
    it('adds the human title for known ids', () => {
        expect(describeCwe('CWE-918')).toBe(
            'CWE-918 (Server-Side Request Forgery (SSRF))',
        );
    });

    it('falls back to the bare id for ids outside the catalog', () => {
        expect(describeCwe('CWE-9999')).toBe('CWE-9999');
    });

    it('is undefined when there is no id', () => {
        expect(describeCwe('not a cwe')).toBeUndefined();
    });
});

describe('cweUrl', () => {
    it('builds the MITRE definition link', () => {
        expect(cweUrl('CWE-89')).toBe(
            'https://cwe.mitre.org/data/definitions/89.html',
        );
    });

    it('is undefined when there is no id', () => {
        expect(cweUrl(undefined)).toBeUndefined();
    });
});
