import {
    detectFileLanguage,
    detectPrLanguages,
    touchesDatabaseSurface,
    buildExpertRoles,
    buildExpertRolePrompt,
    buildExpertArbitrationPrompt,
    buildSkepticArbitrationPrompt,
    RECOGNITION_PANEL_ROLES,
} from './expert-panel';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

function file(filename: string): FileChange {
    return { filename } as FileChange;
}

describe('detectFileLanguage', () => {
    it('maps common extensions to a language name', () => {
        expect(detectFileLanguage('app/models/post.rb')).toBe('Ruby');
        expect(detectFileLanguage('pkg/services/db.go')).toBe('Go');
        expect(detectFileLanguage('src/main.py')).toBe('Python');
        expect(detectFileLanguage('Handler.java')).toBe('Java');
        expect(detectFileLanguage('components/Card.tsx')).toBe('TypeScript');
    });

    it('returns undefined for unknown/no extension', () => {
        expect(detectFileLanguage('Makefile')).toBeUndefined();
        expect(detectFileLanguage('config.yaml')).toBeUndefined();
    });
});

describe('detectPrLanguages', () => {
    it('orders languages by how many changed files use them', () => {
        const files = [
            file('a.rb'),
            file('b.rb'),
            file('c.go'),
            file('d.rb'),
        ];
        expect(detectPrLanguages(files)).toEqual(['Ruby', 'Go']);
    });

    it('is empty when no changed file maps to a known language', () => {
        expect(detectPrLanguages([file('README.md')])).toEqual([]);
    });
});

describe('touchesDatabaseSurface', () => {
    it('detects migration/schema/sql paths', () => {
        expect(
            touchesDatabaseSurface([file('db/migrations/001_add_x.rb')]),
        ).toBe(true);
        expect(touchesDatabaseSurface([file('scripts/seed.sql')])).toBe(true);
        expect(
            touchesDatabaseSurface([file('packages/prisma/schema.prisma')]),
        ).toBe(true);
    });

    it('is false for a PR with no DB-shaped path', () => {
        expect(
            touchesDatabaseSurface([file('src/components/Button.tsx')]),
        ).toBe(false);
    });
});

describe('buildExpertRoles', () => {
    it('includes a language specialist per distinct language present', () => {
        const roles = buildExpertRoles([file('a.rb'), file('b.go')]);
        const names = roles.map((r) => r.name);
        expect(names).toContain('Ruby Specialist');
        expect(names).toContain('Go Specialist');
    });

    it('always includes the fixed roles', () => {
        const roles = buildExpertRoles([file('a.rb')]);
        const names = roles.map((r) => r.name);
        expect(names).toContain('Security Specialist');
        expect(names).toContain('Performance Specialist');
        expect(names).toContain('QA / Test Specialist');
    });

    it('includes the DBA role only when the diff touches DB surface', () => {
        const withDb = buildExpertRoles([file('db/migrate/1_x.rb')]);
        const withoutDb = buildExpertRoles([file('app/models/post.rb')]);
        expect(withDb.map((r) => r.name)).toContain('Database Specialist');
        expect(withoutDb.map((r) => r.name)).not.toContain(
            'Database Specialist',
        );
    });
});

describe('buildExpertRolePrompt', () => {
    it('scopes the pass to the role focus and forbids reporting outside it', () => {
        const prompt = buildExpertRolePrompt('BASE PROMPT', {
            name: 'Security Specialist',
            focus: 'exploit paths',
        });
        expect(prompt).toContain('BASE PROMPT');
        expect(prompt).toContain('Security Specialist');
        expect(prompt).toContain('exploit paths');
        expect(prompt).toContain('Do not report anything outside this lens');
    });
});

describe('buildExpertArbitrationPrompt', () => {
    it('renders every role, including one that found nothing', () => {
        const prompt = buildExpertArbitrationPrompt('BASE PROMPT', [
            {
                role: 'Security Specialist',
                suggestions: [
                    {
                        relevantFile: 'a.rb',
                        suggestionContent: 'SSRF via open()',
                        existingCode: '',
                        improvedCode: '',
                    },
                ],
            },
            { role: 'Performance Specialist', suggestions: [] },
        ]);
        expect(prompt).toContain('### Security Specialist');
        expect(prompt).toContain('SSRF via open()');
        expect(prompt).toContain('### Performance Specialist');
        expect(prompt).toContain('found nothing in its lens');
        expect(prompt).toContain('reconcile the panel into a FINAL verdict');
    });
});

describe('RECOGNITION_PANEL_ROLES', () => {
    it('has exactly 4 fixed roles, distinct from the topic-based FIXED_ROLES', () => {
        expect(RECOGNITION_PANEL_ROLES).toHaveLength(4);
        const names = RECOGNITION_PANEL_ROLES.map((r) => r.name);
        expect(names).toEqual([
            'Contract Auditor',
            'Data-Flow / Reference Tracer',
            'Cross-Method Consistency Checker',
            'Failure-Path Specialist',
        ]);
        for (const role of RECOGNITION_PANEL_ROLES) {
            expect(role.focus.length).toBeGreaterThan(0);
        }
    });
});

describe('buildSkepticArbitrationPrompt', () => {
    it('renders every role, including silent ones, with adversarial framing', () => {
        const prompt = buildSkepticArbitrationPrompt('BASE PROMPT', [
            {
                role: 'Contract Auditor',
                suggestions: [
                    {
                        relevantFile: 'a.java',
                        suggestionContent: 'returns null, violates contract',
                        existingCode: '',
                        improvedCode: '',
                    },
                ],
            },
            { role: 'Failure-Path Specialist', suggestions: [] },
        ]);
        expect(prompt).toContain('### Contract Auditor');
        expect(prompt).toContain('returns null, violates contract');
        expect(prompt).toContain('### Failure-Path Specialist');
        expect(prompt).toContain('found nothing in its lens');
        expect(prompt).toContain('challenge EVERY lens');
        expect(prompt).toContain('STRONGEST case');
    });

    it('renders cleanly when every lens is silent (the case it exists to challenge)', () => {
        const prompt = buildSkepticArbitrationPrompt('BASE PROMPT', [
            { role: 'Contract Auditor', suggestions: [] },
            { role: 'Failure-Path Specialist', suggestions: [] },
        ]);
        expect(prompt).toContain('challenge EVERY lens');
        expect((prompt.match(/found nothing in its lens/g) || []).length).toBeGreaterThanOrEqual(2);
    });
});
