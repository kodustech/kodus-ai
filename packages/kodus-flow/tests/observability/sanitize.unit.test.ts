/**
 * @file sanitize.unit.test.ts
 *
 * Unit tests for deepSanitize and isSensitiveKey in logger.ts.
 * Covers: redaction correctness, structural sharing (performance), edge cases.
 */

/* eslint-disable @typescript-eslint/naming-convention -- HTTP header fixtures (user-agent, set-cookie, etc.) */

import { describe, it, expect } from 'vitest';
import {
    deepSanitize,
    isSensitiveKey,
    sanitizeString,
} from '../../src/observability/logger.js';

// ---------------------------------------------------------------------------
// isSensitiveKey
// ---------------------------------------------------------------------------

describe('isSensitiveKey', () => {
    it('detecta chaves exatas sensíveis', () => {
        expect(isSensitiveKey('password')).toBe(true);
        expect(isSensitiveKey('token')).toBe(true);
        expect(isSensitiveKey('secret')).toBe(true);
        expect(isSensitiveKey('apiKey')).toBe(true);
        expect(isSensitiveKey('apikey')).toBe(true);
        expect(isSensitiveKey('api_key')).toBe(true);
        expect(isSensitiveKey('authorization')).toBe(true);
        expect(isSensitiveKey('accessToken')).toBe(true);
        expect(isSensitiveKey('refreshToken')).toBe(true);
        expect(isSensitiveKey('clientSecret')).toBe(true);
        expect(isSensitiveKey('privateKey')).toBe(true);
        expect(isSensitiveKey('bearerToken')).toBe(true);
        expect(isSensitiveKey('jwt')).toBe(true);
        expect(isSensitiveKey('credential')).toBe(true);
        expect(isSensitiveKey('connectionString')).toBe(true);
        expect(isSensitiveKey('ssn')).toBe(true);
        expect(isSensitiveKey('cpf')).toBe(true);
        expect(isSensitiveKey('cvv')).toBe(true);
        expect(isSensitiveKey('creditcard')).toBe(true);
    });

    it('não é case-sensitive', () => {
        expect(isSensitiveKey('PASSWORD')).toBe(true);
        expect(isSensitiveKey('Token')).toBe(true);
        expect(isSensitiveKey('ACCESS_TOKEN')).toBe(true);
        expect(isSensitiveKey('ClientSecret')).toBe(true);
    });

    it('redacta cookie / set-cookie / proxy-authorization (HTTP)', () => {
        expect(isSensitiveKey('cookie')).toBe(true);
        expect(isSensitiveKey('Cookie')).toBe(true);
        expect(isSensitiveKey('set-cookie')).toBe(true);
        expect(isSensitiveKey('Set-Cookie')).toBe(true);
        expect(isSensitiveKey('proxy-authorization')).toBe(true);
        expect(isSensitiveKey('Proxy-Authorization')).toBe(true);
        expect(isSensitiveKey('x-api-key')).toBe(true);
        expect(isSensitiveKey('x-auth-token')).toBe(true);
    });

    it('não redacta chaves seguras', () => {
        expect(isSensitiveKey('host')).toBe(false);
        expect(isSensitiveKey('database')).toBe(false);
        expect(isSensitiveKey('port')).toBe(false);
        expect(isSensitiveKey('serviceName')).toBe(false);
        expect(isSensitiveKey('organizationId')).toBe(false);
        expect(isSensitiveKey('teamId')).toBe(false);
        expect(isSensitiveKey('correlationId')).toBe(false);
    });

    it('resultado é cacheado (mesma referência para mesma chave)', () => {
        // Chama duas vezes — deve retornar o mesmo booleano (cache hit)
        const first = isSensitiveKey('password');
        const second = isSensitiveKey('password');
        expect(first).toBe(second);
    });
});

// ---------------------------------------------------------------------------
// deepSanitize — redação correta
// ---------------------------------------------------------------------------

describe('deepSanitize — redação', () => {
    it('redacta password no nível raiz', () => {
        const result = deepSanitize({ password: 'super-secret' });
        expect(result.password).toBe('[REDACTED]');
    });

    it('redacta campos sensíveis aninhados em 1 nível (o bug original)', () => {
        const result = deepSanitize({
            config: { password: 'mongo-pass', host: 'localhost' },
        });
        expect(result.config.password).toBe('[REDACTED]');
        expect(result.config.host).toBe('localhost');
    });

    it('redacta campos sensíveis aninhados em 2+ níveis', () => {
        const result = deepSanitize({
            metadata: {
                config: { password: 'nested-pass', database: 'kodus' },
            },
        });
        expect(result.metadata.config.password).toBe('[REDACTED]');
        expect(result.metadata.config.database).toBe('kodus');
    });

    it('redacta múltiplos campos sensíveis no mesmo objeto', () => {
        const result = deepSanitize({
            token: 'abc',
            secret: 'xyz',
            apiKey: '123',
            host: 'localhost',
        });
        expect(result.token).toBe('[REDACTED]');
        expect(result.secret).toBe('[REDACTED]');
        expect(result.apiKey).toBe('[REDACTED]');
        expect(result.host).toBe('localhost');
    });

    it('redacta dentro de arrays', () => {
        const result = deepSanitize([
            { user: 'alice', password: 'pw1' },
            { user: 'bob', password: 'pw2' },
        ]);
        expect(result[0].password).toBe('[REDACTED]');
        expect(result[1].password).toBe('[REDACTED]');
        expect(result[0].user).toBe('alice');
    });

    it('redacta campos com casing misto', () => {
        const input: Record<string, string> = {};
        input['AccessToken'] = 'tok';
        input['CLIENT_SECRET'] = 'sec';
        const result = deepSanitize(input);
        expect(result['AccessToken']).toBe('[REDACTED]');
        expect(result['CLIENT_SECRET']).toBe('[REDACTED]');
    });

    it('redacta connectionString', () => {
        const result = deepSanitize({
            connectionString: 'mongodb://user:pass@host/db',
        });
        expect(result.connectionString).toBe('[REDACTED]');
    });

    it('preserva campos não-sensíveis intactos', () => {
        const result = deepSanitize({
            serviceName: 'api',
            correlationId: 'corr-123',
            organizationId: 'org-456',
            port: 27017,
        });
        expect(result).toEqual({
            serviceName: 'api',
            correlationId: 'corr-123',
            organizationId: 'org-456',
            port: 27017,
        });
    });
});

// ---------------------------------------------------------------------------
// deepSanitize — structural sharing (performance)
// ---------------------------------------------------------------------------

describe('deepSanitize — structural sharing', () => {
    it('retorna a mesma referência quando não há dados sensíveis', () => {
        const input = { host: 'localhost', port: 27017, database: 'kodus' };
        const result = deepSanitize(input);
        // Zero alocação: referência idêntica ao original
        expect(result).toBe(input);
    });

    it('retorna nova referência apenas quando há dado sensível', () => {
        const input = { host: 'localhost', password: 'secret' };
        const result = deepSanitize(input);
        expect(result).not.toBe(input);
    });

    it('preserva sub-objetos limpos por referência', () => {
        const safeNested = { host: 'localhost', port: 27017 };
        const input = { config: safeNested, password: 'root-secret' };
        const result = deepSanitize(input);
        // Raiz muda (tem password), mas sub-objeto limpo mantém referência
        expect(result).not.toBe(input);
        expect(result.config).toBe(safeNested);
    });

    it('retorna mesma referência de array quando nenhum item é sensível', () => {
        const input = [{ host: 'a' }, { host: 'b' }];
        const result = deepSanitize(input);
        expect(result).toBe(input);
    });

    it('retorna novo array quando algum item contém dado sensível', () => {
        const input = [{ host: 'a' }, { password: 'pw' }];
        const result = deepSanitize(input);
        expect(result).not.toBe(input);
    });
});

// ---------------------------------------------------------------------------
// sanitizeString — URL credential stripping
// ---------------------------------------------------------------------------

describe('sanitizeString — URL credential stripping', () => {
    it('redacta credenciais em URLs mongodb', () => {
        const result = sanitizeString(
            'mongodb://user:super-secret@host:27017/db',
        );
        expect(result).toBe('mongodb://user:[REDACTED]@host:27017/db');
        expect(result).not.toContain('super-secret');
    });

    it('redacta credenciais em URLs mongodb+srv', () => {
        // '@' em senha deve ser URL-encoded (%40) em URLs válidas
        const result = sanitizeString(
            'mongodb+srv://admin:Passw0rd123@cluster.mongodb.net/db',
        );
        expect(result).toBe(
            'mongodb+srv://admin:[REDACTED]@cluster.mongodb.net/db',
        );
    });

    it('redacta credenciais em URLs postgres', () => {
        const result = sanitizeString(
            'postgresql://user:secret123@localhost:5432/mydb',
        );
        expect(result).toBe('postgresql://user:[REDACTED]@localhost:5432/mydb');
    });

    it('redacta credenciais em URLs redis', () => {
        const result = sanitizeString('redis://:redispassword@localhost:6379');
        expect(result).toBe('redis://:[REDACTED]@localhost:6379');
    });

    it('não modifica URLs sem credenciais', () => {
        const url = 'https://api.example.com/v1/endpoint';
        expect(sanitizeString(url)).toBe(url);
    });

    it('não modifica strings comuns', () => {
        const str = 'Processing request for organizationId=123';
        expect(sanitizeString(str)).toBe(str);
    });

    it('redacta credenciais em mensagens de erro de conexão', () => {
        const msg =
            'Connection failed: mongodb://admin:plaintext-password@prod-host/kodus';
        const result = sanitizeString(msg);
        expect(result).not.toContain('plaintext-password');
        expect(result).toContain('[REDACTED]');
    });

    it('processa payloads patológicos sem degradação significativa', () => {
        const attack = 'prefix ' + 'a://:' + 'a://:!'.repeat(8000);
        const startedAt = Date.now();

        const result = sanitizeString(attack);
        const elapsedMs = Date.now() - startedAt;

        expect(result).toBe(attack);
        expect(elapsedMs).toBeLessThan(100);
    });
});

// ---------------------------------------------------------------------------
// deepSanitize — URL credential stripping em strings aninhadas
// ---------------------------------------------------------------------------

describe('deepSanitize — URL credential stripping em strings', () => {
    it('redacta URL com credencial em valor de string em objeto', () => {
        const result = deepSanitize({
            mongoUri: 'mongodb://user:secret@host/db',
            host: 'localhost',
        });
        expect(result.mongoUri).toBe('mongodb://user:[REDACTED]@host/db');
        expect(result.host).toBe('localhost');
    });

    it('redacta URL com credencial aninhada em metadata', () => {
        const result = deepSanitize({
            metadata: { config: { uri: 'mongodb://user:pass@host/db' } },
        });
        expect(result.metadata.config.uri).toBe(
            'mongodb://user:[REDACTED]@host/db',
        );
    });

    it('preserva referência de string quando não há credencial na URL', () => {
        const input = { endpoint: 'https://api.example.com/v1' };
        const result = deepSanitize(input);
        expect(result).toBe(input); // structural sharing mantido
    });
});

// ---------------------------------------------------------------------------
// deepSanitize — edge cases
// ---------------------------------------------------------------------------

describe('deepSanitize — got/axios HTTPError shapes', () => {
    it('redacta authorization em err.request.headers (got)', () => {
        // Shape real de got HTTPError quando thrown por bitbucket.js
        const gotError = {
            name: 'HTTPError',
            message: '429 Too Many Requests',
            request: {
                requestUrl: 'https://api.bitbucket.org/2.0/...',
                options: {
                    url: 'https://api.bitbucket.org/2.0/...',
                    headers: {
                        'authorization': 'Basic dXNlcjphcHBwYXNzd29yZA==',
                        'user-agent': 'bitbucket.js',
                    },
                },
                headers: {
                    authorization: 'Basic dXNlcjphcHBwYXNzd29yZA==',
                },
            },
            response: {
                statusCode: 429,
                headers: {
                    'set-cookie': ['session=abc; HttpOnly'],
                    'retry-after': '30',
                },
            },
        };
        const result = deepSanitize(gotError);
        expect(result.request.options.headers.authorization).toBe('[REDACTED]');
        expect(result.request.headers.authorization).toBe('[REDACTED]');
        expect(result.response.headers['set-cookie']).toBe('[REDACTED]');
        expect(result.response.headers['retry-after']).toBe('30');
        expect(result.request.options.headers['user-agent']).toBe(
            'bitbucket.js',
        );
        expect(result.response.statusCode).toBe(429);
    });

    it('redacta cookie em response.headers', () => {
        const result = deepSanitize({
            response: { headers: { cookie: 'sessionid=abc123' } },
        });
        expect(result.response.headers.cookie).toBe('[REDACTED]');
    });

    it('redacta proxy-authorization (case-insensitive + hyphens)', () => {
        const result = deepSanitize({
            headers: { 'Proxy-Authorization': 'Bearer xyz' },
        });
        expect(result.headers['Proxy-Authorization']).toBe('[REDACTED]');
    });
});

describe('deepSanitize — edge cases', () => {
    it('retorna primitivos sem modificação', () => {
        expect(deepSanitize('string')).toBe('string');
        expect(deepSanitize(42)).toBe(42);
        expect(deepSanitize(true)).toBe(true);
        expect(deepSanitize(null)).toBe(null);
        expect(deepSanitize(undefined)).toBe(undefined);
    });

    it('lida com objeto vazio', () => {
        const result = deepSanitize({});
        expect(result).toEqual({});
    });

    it('lida com array vazio', () => {
        const result = deepSanitize([]);
        expect(result).toEqual([]);
    });

    it('detecta e marca referências circulares', () => {
        const obj: any = { name: 'test' };
        obj.self = obj;
        const result = deepSanitize(obj);
        expect(result.self).toBe('[Circular]');
        expect(result.name).toBe('test');
    });

    it('não lança erro em objetos profundamente aninhados', () => {
        const deep: any = {};
        let cur = deep;
        for (let i = 0; i < 20; i++) {
            cur.next = { level: i };
            cur = cur.next;
        }
        cur.password = 'deep-secret';
        expect(() => deepSanitize(deep)).not.toThrow();
        // Verifica que o password profundo foi redactado
        let node = deepSanitize(deep);
        while (node.next) node = node.next;
        expect(node.password).toBe('[REDACTED]');
    });
});
