import {
    buildReport,
    collectSecretValues,
    redact,
    sortResults,
    verdictOf,
} from '../doctor-report';
import { DoctorResult } from '../doctor.types';

const r = (status: DoctorResult['status'], title = status): DoctorResult => ({
    check: 'x',
    status,
    title,
});

describe('doctor report', () => {
    it('verdict: any fail is NOT_RUNNING, else any warn is DEGRADED, else OK', () => {
        expect(verdictOf([r('ok'), r('warn'), r('fail')])).toBe('NOT_RUNNING');
        expect(verdictOf([r('ok'), r('warn'), r('info')])).toBe('DEGRADED');
        // unknown / info / skip never change the verdict
        expect(verdictOf([r('ok'), r('unknown'), r('info'), r('skip')])).toBe(
            'OK',
        );
    });

    it('orders worst first and keeps check order within a status', () => {
        const sorted = sortResults([
            r('ok', 'ok1'),
            r('info', 'info1'),
            r('fail', 'fail1'),
            r('warn', 'warn1'),
            r('fail', 'fail2'),
            r('skip', 'skip1'),
            r('unknown', 'unknown1'),
        ]);
        expect(sorted.map((x) => x.title)).toEqual([
            'fail1',
            'fail2',
            'warn1',
            'unknown1',
            'info1',
            'skip1',
            'ok1',
        ]);
    });

    describe('secrets never reach the output', () => {
        const env = {
            API_CRYPTO_KEY: 'a'.repeat(64),
            API_OPEN_AI_API_KEY: 'sk-live-planted-openai-secret',
            API_PG_DB_PASSWORD: 'planted-pg-password',
            API_RABBITMQ_URI:
                'amqp://kodus:planted-rabbit-pass@rabbitmq:5672/kodus-ai',
            API_PORT: '3001',
            API_LOG_LEVEL: 'info',
        } as NodeJS.ProcessEnv;

        it('collects only secret-named values long enough to scrub', () => {
            const secrets = collectSecretValues(env);
            expect(secrets).toContain('planted-pg-password');
            expect(secrets).not.toContain('3001');
            expect(secrets).not.toContain('info');
        });

        it('scrubs env secrets, URL credentials, auth headers and token prefixes', () => {
            const text = [
                `key ${env.API_OPEN_AI_API_KEY}`,
                `pg ${env.API_PG_DB_PASSWORD}`,
                'clone https://oauth2:glpat-abcdefghijklmnop@gitlab.example.com/x.git',
                'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
                'token ghp_abcdefghijklmnopqrstuvwxyz0123',
                'plain words stay',
                'Optional: set KODUS_LICENSE_KEY and API_CRYPTO_KEY.',
                'team key kodus_abcdefgh12345',
                'Incorrect API key provided: sk-svcac****************VeAA. You c',
            ].join('\n');
            const out = redact(text, collectSecretValues(env));
            for (const secret of [
                'sk-live-planted-openai-secret',
                'planted-pg-password',
                'glpat-abcdefghijklmnop',
                'abcdefghijklmnopqrstuvwxyz',
                'ghp_abcdefghijklmnopqrstuvwxyz0123',
            ]) {
                expect(out).not.toContain(secret);
            }
            expect(out).toContain('plain words stay');
            // env var NAMES in fixes are not secrets
            expect(out).toContain('KODUS_LICENSE_KEY and API_CRYPTO_KEY');
            expect(out).not.toContain('kodus_abcdefgh12345');
            expect(out).not.toContain('sk-svcac');
            expect(out).not.toContain('VeAA');
            expect(out).toContain('gitlab.example.com');
        });

        it('buildReport redacts every text field and serializes no secret', () => {
            const report = buildReport({
                env,
                startedAt: Date.now(),
                results: [
                    {
                        check: 'llm.completion',
                        status: 'fail',
                        title: `model with key ${env.API_OPEN_AI_API_KEY}`,
                        impact: `uri ${env.API_RABBITMQ_URI}`,
                        fix: `password ${env.API_PG_DB_PASSWORD}`,
                        scope: `org ${env.API_CRYPTO_KEY}`,
                    },
                ],
            });
            const json = JSON.stringify(report);
            for (const key of [
                'API_CRYPTO_KEY',
                'API_OPEN_AI_API_KEY',
                'API_PG_DB_PASSWORD',
            ]) {
                expect(json).not.toContain(env[key] as string);
            }
            expect(json).not.toContain('planted-rabbit-pass');
            expect(report.verdict).toBe('NOT_RUNNING');
        });
    });
});
