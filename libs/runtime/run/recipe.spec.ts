import { readFileSync } from 'fs';
import { join } from 'path';

import { parseRecipeSummary, recipeDigest } from './recipe';

const err = (text: string) => {
    const r = parseRecipeSummary(text);
    return 'error' in r ? r.error : null;
};

describe('parseRecipeSummary', () => {
    it('reads the sample app recipe the local-docker driver boots', () => {
        const text = readFileSync(join(__dirname, '../../../experiments/kody-runtime/sample-app/app/.kodus/workspace.yaml'), 'utf8');
        expect(parseRecipeSummary(text)).toEqual({
            ok: true,
            recipe: { version: 1, expose: [{ service: 'app', port: 3000, kind: 'http' }], public: 'app', health: '/health', healthTimeoutSeconds: 120 },
        });
    });

    it('keeps the cell rules: version 1, known keys, valid and unique expose entries, health on a public http entry', () => {
        expect(err('')).toBe('recipe: empty');
        expect(err('version: 2')).toBe('recipe: version must be 1, got 2');
        expect(err('version: 1\nimage: node')).toBe('recipe: unknown field "image"');
        expect(err('version: 1\nservices: { compose: {}, extra: 1 }')).toContain('services.extra: a cell boots a compose project');
        expect(err('version: 1\nservices: { compose: { helth: /x } }')).toBe('recipe: services.compose: unknown field "helth"');
        expect(err('version: 1\nservices:\n  expose: [{ service: app, port: 0, kind: http }]')).toContain('services.expose[0]');
        expect(err('version: 1\nservices:\n  expose: [{ service: app, port: 80, kind: ftp }]')).toContain('services.expose[0]');
        expect(err('version: 1\nservices:\n  expose: [{ service: a, port: 80, kind: http }, { service: a, port: 80, kind: http }]')).toBe(
            'recipe: services.expose[1]: a/80 twice',
        );
        expect(err('version: 1\nservices:\n  compose: { health: /h }\n  expose: [{ service: a, port: 80, kind: http }]')).toContain(
            'needs services.compose.public',
        );
        expect(err('version: 1\nservices:\n  compose: { public: a, health: h }\n  expose: [{ service: a, port: 80, kind: http }]')).toContain('must be a path');
        expect(err('version: 1\n  bad: [indent')).toMatch(/^recipe: /);
    });

    it('preserves normalized fake requirements without treating them as arbitrary compose capabilities', () => {
        const image = `axllent/mailpit@sha256:${'b'.repeat(64)}`;
        const out = parseRecipeSummary(`version: 1\nfakes: { email: { image: ${image}, env: { SMTP_HOST: mailpit } } }\n`);
        expect(out).toEqual({ ok: true, recipe: { version: 1, expose: [], fakes: [{ kind: 'email', service: 'mailpit', image, env: { SMTP_HOST: 'mailpit' } }] } });
    });

    it('drops the cell-only expose fields and digests the exact text', () => {
        const r = parseRecipeSummary('version: 1\nservices:\n  expose: [{ service: db, port: 5432, kind: postgres, readonly_user_from_seed: true }]\n');
        expect(r).toEqual({ ok: true, recipe: { version: 1, expose: [{ service: 'db', port: 5432, kind: 'postgres' }] } });
        expect(recipeDigest('a')).toBe('sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    });
});
