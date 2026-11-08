import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDeclaredEnvProvider } from './env-declared-provider';

it('keeps the managed model route valid after preview secrets are neutralized', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kodus-preview-model-env-'));
    try {
        const env = join(dir, '.env');
        const template = join(dir, '.env.template');
        writeFileSync(
            env,
            [
                'API_LLM_PROVIDER_MODEL=auto',
                'API_LLM_PROVIDER=',
                'API_LLM_API_KEY=private-developer-key',
                'API_FIREWORKS_API_KEY=private-developer-fireworks-key',
            ].join('\n'),
        );
        writeFileSync(
            template,
            [
                'API_LLM_API_KEY=op://test/llm/password',
                'API_FIREWORKS_API_KEY=op://test/fireworks/password',
            ].join('\n'),
        );
        execFileSync(
            'bash',
            [
                resolve('scripts/preview/neutralize-preview-env.sh'),
                env,
                template,
            ],
            {
                env: {
                    ...process.env,
                    PREVIEW_SECRET_SEED: 'isolated-preview-fixture',
                },
                stdio: 'pipe',
            },
        );
        const text = readFileSync(env, 'utf8');
        const vars = Object.fromEntries(
            text
                .split('\n')
                .filter((line) => /^[A-Z_]+=/.test(line))
                .map((line) => {
                    const at = line.indexOf('=');
                    return [line.slice(0, at), line.slice(at + 1)];
                }),
        );
        expect(text).not.toContain('private-developer');
        expect(vars.API_FIREWORKS_API_KEY).toBe('preview-disabled');
        expect(resolveDeclaredEnvProvider(vars)).toEqual({ kind: 'inferred' });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
