import { ownersFor, parseCodeowners } from './codeowners';

describe('CODEOWNERS', () => {
    const rules = parseCodeowners(`
# Default owners
*                       @acme/platform

/src/payments/          @acme/payments ana@acme.io
*.sql                   @dba
docs/**                 @acme/docs
apps/*/auth.ts          @acme/security

[Backend][2] @acme/backend
/services/              @acme/backend   # inline comment
`);

    it.each([
        ['README.md', ['@acme/platform']],
        ['src/payments/charge.ts', ['@acme/payments', 'ana@acme.io']],
        ['src/payments/deep/refund.ts', ['@acme/payments', 'ana@acme.io']],
        ['db/migrations/001.sql', ['@dba']],
        ['src/payments/schema.sql', ['@dba']],
        ['docs/guide/setup.md', ['@acme/docs']],
        ['apps/web/auth.ts', ['@acme/security']],
        ['apps/web/nested/auth.ts', ['@acme/platform']],
        ['services/orders/handler.go', ['@acme/backend']],
        ['./services/orders/handler.go', ['@acme/backend']],
    ])('owns %s', (file, owners) => {
        expect(ownersFor(rules, file)).toEqual(owners);
    });

    it('anchors a pattern with a slash to the root', () => {
        const anchored = parseCodeowners('/src/payments/ @team');
        expect(ownersFor(anchored, 'lib/src/payments/a.ts')).toEqual([]);
    });

    it('owns only the files directly in a folder for `folder/*`, as GitHub does', () => {
        const shallow = parseCodeowners('docs/*  @docs');
        expect(ownersFor(shallow, 'docs/getting-started.md')).toEqual([
            '@docs',
        ]);
        expect(ownersFor(shallow, 'docs/build-app/troubleshooting.md')).toEqual(
            [],
        );
    });

    it('matches a bare name at any depth', () => {
        const bare = parseCodeowners('auth @sec');
        expect(ownersFor(bare, 'apps/api/auth/guard.ts')).toEqual(['@sec']);
    });

    it('returns no owner when nothing matches', () => {
        expect(
            ownersFor(parseCodeowners('/only/ @x'), 'other/file.ts'),
        ).toEqual([]);
    });
});

describe('untrusted CODEOWNERS', () => {
    it('matches an escaped hash at the start of a filename', () => {
        expect(ownersFor(parseCodeowners('\\#file @owner'), '#file')).toEqual(['@owner']);
    });
    it('finishes a hostile wildcard pattern without exponential backtracking', () => {
        const start = performance.now();
        expect(ownersFor(parseCodeowners('*a'.repeat(30) + '*b @owner'), 'a'.repeat(400))).toEqual([]);
        expect(performance.now() - start).toBeLessThan(100);
    });
});
