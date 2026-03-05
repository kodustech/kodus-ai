#!/usr/bin/env node
/**
 * Builds agent_verification.jsonl with realistic repo fixtures.
 * Run: node evals/promptfoo-safeguard/build-dataset.js
 */
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// Shared noise files — added to every repo fixture
// ═══════════════════════════════════════════════════════════════

const NOISE = {
    'package.json': JSON.stringify({
        name: '@acme/backend-api',
        version: '2.4.1',
        private: true,
        scripts: {
            start: 'node dist/app.js',
            build: 'tsc -p tsconfig.json',
            dev: 'ts-node-dev --respawn src/app.ts',
            test: 'jest --coverage',
            lint: 'eslint src/ --ext .ts',
            migrate: 'knex migrate:latest',
        },
        dependencies: {
            express: '^4.18.2',
            pg: '^8.11.3',
            ioredis: '^5.3.2',
            nodemailer: '^6.9.7',
            bcrypt: '^5.1.1',
            jsonwebtoken: '^9.0.2',
            winston: '^3.11.0',
            zod: '^3.22.4',
            axios: '^1.6.2',
            uuid: '^9.0.0',
        },
        devDependencies: {
            typescript: '^5.3.2',
            '@types/express': '^4.17.21',
            '@types/pg': '^8.10.9',
            jest: '^29.7.0',
            'ts-jest': '^29.1.1',
            '@types/jest': '^29.5.11',
        },
    }, null, 2),

    'tsconfig.json': JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'commonjs',
            lib: ['ES2022'],
            outDir: './dist',
            rootDir: './src',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            resolveJsonModule: true,
            declaration: true,
            declarationMap: true,
            sourceMap: true,
        },
        include: ['src/**/*'],
        exclude: ['node_modules', 'dist', 'test'],
    }, null, 2),

    'src/utils/logger.ts': `import winston from 'winston';

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
    ],
});

export function logError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(\`[\${context}] \${message}\`, {
        stack: error instanceof Error ? error.stack : undefined,
    });
}

export function logWarning(context: string, message: string): void {
    logger.warn(\`[\${context}] \${message}\`);
}

export default logger;
`,

    'src/config/index.ts': `import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    DB_HOST: z.string().default('localhost'),
    DB_PORT: z.coerce.number().default(5432),
    DB_NAME: z.string().default('app'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    JWT_SECRET: z.string().min(32),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    LOG_LEVEL: z.string().default('info'),
});

export const config = envSchema.parse(process.env);
export type AppConfig = z.infer<typeof envSchema>;
`,

    'src/middleware/error-handler.ts': `import { Request, Response, NextFunction } from 'express';
import { logError } from '../utils/logger';

export class AppError extends Error {
    constructor(
        public statusCode: number,
        message: string,
    ) {
        super(message);
        this.name = 'AppError';
    }
}

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction,
): void {
    logError('http', err);

    if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
    }

    res.status(500).json({ error: 'Internal server error' });
}
`,

    'src/types/index.ts': `export interface BaseEntity {
    id: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface PaginationParams {
    page: number;
    limit: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

export interface ApiResponse<T> {
    data: T;
    meta?: { total: number; page: number; limit: number };
    error?: string;
}

export interface ServiceResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}
`,

    'src/utils/retry.ts': `export async function withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 3,
    delayMs: number = 1000,
): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, delayMs * attempt));
            }
        }
    }
    throw lastError!;
}
`,

    'test/helpers/setup.ts': `import { jest } from '@jest/globals';

export function createMockLogger() {
    return {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
}

export function createMockDb() {
    return {
        query: jest.fn(),
        getClient: jest.fn(),
        release: jest.fn(),
    };
}

export function createMockTransporter() {
    return {
        sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
    };
}
`,
};

// ═══════════════════════════════════════════════════════════════
// Helper to build a test case
// ═══════════════════════════════════════════════════════════════

function buildCase({
    scenario,
    description,
    expected,
    filePath,
    language,
    fileContent,
    patchWithLinesStr,
    suggestion,
    repoFiles,
    noiseOverrides,
}) {
    const repoFixture = {
        ...NOISE,
        ...(noiseOverrides || {}),
        ...repoFiles,
    };

    return {
        metadata: {
            expected_action: expected,
            scenario,
            description,
        },
        inputs: {
            filePath,
            language: language || 'typescript',
            fileContent,
            patchWithLinesStr,
            suggestionsToEvaluate: [suggestion],
            crossFileSnippets: [],
            repoFixture,
        },
        outputs: {
            expectedActions: [{ id: suggestion.id || '1', action: expected }],
            expectedReason: description,
        },
    };
}

// ═══════════════════════════════════════════════════════════════
// Scenario definitions
// ═══════════════════════════════════════════════════════════════

const CONNECTION_POOL_TS = `import { Pool, PoolClient } from 'pg';

export class ConnectionPool {
    private pool: Pool;

    constructor(config: PoolConfig) {
        this.pool = new Pool(config);
    }

    async getClient(): Promise<PoolClient> {
        const client = await this.pool.connect();
        return client;
    }

    async query(sql: string, params?: any[]): Promise<QueryResult> {
        const client = await this.getClient();
        const result = await client.query(sql, params);
        return result;
    }

    async shutdown(): Promise<void> {
        await this.pool.end();
    }
}
`;

const CONNECTION_POOL_PATCH = `@@ -14,7 +14,12 @@
+    async query(sql: string, params?: any[]): Promise<QueryResult> {
+        const client = await this.getClient();
+        const result = await client.query(sql, params);
+        return result;
+    }`;

const RESOURCE_LEAK_SUGGESTION = {
    id: '1',
    suggestionContent:
        "Resource leak in `ConnectionPool.query()`. Lines 15-19 acquire a `PoolClient` via `this.getClient()` (which calls `this.pool.connect()`) but never call `client.release()` to return it to the pool. Each invocation of `query()` permanently consumes one connection from the pool. Concrete scenario: with a pool of max 20 connections, 20 calls to `query()` will exhaust the pool and the 21st call blocks indefinitely, causing the application to hang. The pg `Pool` does NOT auto-release clients — `release()` must be called explicitly.",
    existingCode: `async query(sql: string, params?: any[]): Promise<QueryResult> {
    const client = await this.getClient();
    const result = await client.query(sql, params);
    return result;
}`,
    improvedCode: `async query(sql: string, params?: any[]): Promise<QueryResult> {
    const client = await this.getClient();
    try {
        const result = await client.query(sql, params);
        return result;
    } finally {
        client.release();
    }
}`,
    oneSentenceSummary:
        'Connection pool leak — getClient() acquires PoolClient but query() never calls release()',
    relevantLinesStart: 15,
    relevantLinesEnd: 19,
    label: 'bug_risk',
    severity: 'critical',
};

const scenarios = [];

// ── 1. resource_leak_mitigated (discard) ──
scenarios.push(
    buildCase({
        scenario: 'resource_leak_mitigated',
        description:
            'Suggestion claims resource leak in query() but all callers bypass query() and use getClient() directly with proper try/finally cleanup.',
        expected: 'discard',
        filePath: 'src/database/connection-pool.ts',
        fileContent: CONNECTION_POOL_TS,
        patchWithLinesStr: CONNECTION_POOL_PATCH,
        suggestion: RESOURCE_LEAK_SUGGESTION,
        repoFiles: {
            'src/database/connection-pool.ts': CONNECTION_POOL_TS,
            'src/services/user.service.ts': `import { ConnectionPool } from '../database/connection-pool';

export class UserService {
    constructor(private pool: ConnectionPool) {}

    async getUser(id: string) {
        const client = await this.pool.getClient();
        try {
            const result = await client.query('SELECT * FROM users WHERE id = $1', [id]);
            return result.rows[0];
        } finally {
            client.release();
        }
    }

    async listUsers() {
        const client = await this.pool.getClient();
        try {
            const result = await client.query('SELECT * FROM users');
            return result.rows;
        } finally {
            client.release();
        }
    }
}
`,
            'src/services/order.service.ts': `import { ConnectionPool } from '../database/connection-pool';

export class OrderService {
    constructor(private pool: ConnectionPool) {}

    async createOrder(data: OrderData) {
        const client = await this.pool.getClient();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING *',
                [data.userId, data.total],
            );
            await client.query('COMMIT');
            return result.rows[0];
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
}
`,
            'src/repositories/product.repository.ts': `import { ConnectionPool } from '../database/connection-pool';

export class ProductRepository {
    constructor(private pool: ConnectionPool) {}

    async findById(id: string) {
        const client = await this.pool.getClient();
        try {
            const result = await client.query('SELECT * FROM products WHERE id = $1', [id]);
            return result.rows[0] || null;
        } finally {
            client.release();
        }
    }

    async findByCategory(category: string) {
        const client = await this.pool.getClient();
        try {
            const result = await client.query('SELECT * FROM products WHERE category = $1', [category]);
            return result.rows;
        } finally {
            client.release();
        }
    }
}
`,
            'src/app.ts': `import express from 'express';
import { config } from './config';
import { ConnectionPool } from './database/connection-pool';
import { UserService } from './services/user.service';
import { OrderService } from './services/order.service';
import { errorHandler } from './middleware/error-handler';
import logger from './utils/logger';

const pool = new ConnectionPool({ connectionString: config.DATABASE_URL });
const userService = new UserService(pool);
const orderService = new OrderService(pool);

const app = express();
app.use(express.json());

app.get('/users', async (req, res) => {
    const users = await userService.listUsers();
    res.json(users);
});

app.post('/orders', async (req, res) => {
    const order = await orderService.createOrder(req.body);
    res.json(order);
});

app.use(errorHandler);
app.listen(config.PORT, () => logger.info(\`Server on port \${config.PORT}\`));
`,
            'test/services/user.service.test.ts': `import { UserService } from '../../src/services/user.service';
import { createMockDb } from '../helpers/setup';

describe('UserService', () => {
    let service: UserService;
    let mockPool: any;

    beforeEach(() => {
        mockPool = createMockDb();
        service = new UserService(mockPool);
    });

    it('should get user by id', async () => {
        const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [{ id: '1', name: 'John' }] }),
            release: jest.fn(),
        };
        mockPool.getClient.mockResolvedValue(mockClient);

        const user = await service.getUser('1');
        expect(user).toEqual({ id: '1', name: 'John' });
        expect(mockClient.release).toHaveBeenCalled();
    });
});
`,
        },
    }),
);

// ── 2. resource_leak_real (no_changes) ──
scenarios.push(
    buildCase({
        scenario: 'resource_leak_real',
        description:
            'Suggestion claims resource leak in query() and all callers USE query() directly without manual cleanup.',
        expected: 'no_changes',
        filePath: 'src/database/connection-pool.ts',
        fileContent: CONNECTION_POOL_TS,
        patchWithLinesStr: CONNECTION_POOL_PATCH,
        suggestion: RESOURCE_LEAK_SUGGESTION,
        repoFiles: {
            'src/database/connection-pool.ts': CONNECTION_POOL_TS,
            'src/services/user.service.ts': `import { ConnectionPool } from '../database/connection-pool';

export class UserService {
    constructor(private pool: ConnectionPool) {}

    async getUser(id: string) {
        const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
        return result.rows[0];
    }

    async listUsers() {
        const result = await this.pool.query('SELECT * FROM users');
        return result.rows;
    }
}
`,
            'src/services/order.service.ts': `import { ConnectionPool } from '../database/connection-pool';

export class OrderService {
    constructor(private pool: ConnectionPool) {}

    async createOrder(data: OrderData) {
        const result = await this.pool.query(
            'INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING *',
            [data.userId, data.total],
        );
        return result.rows[0];
    }
}
`,
            'src/repositories/report.repository.ts': `import { ConnectionPool } from '../database/connection-pool';

export class ReportRepository {
    constructor(private pool: ConnectionPool) {}

    async getDailyStats(date: string) {
        const result = await this.pool.query(
            'SELECT COUNT(*) as count, SUM(total) as revenue FROM orders WHERE created_at::date = $1',
            [date],
        );
        return result.rows[0];
    }

    async getTopProducts(limit: number) {
        const result = await this.pool.query(
            'SELECT product_id, SUM(quantity) as total FROM order_items GROUP BY product_id ORDER BY total DESC LIMIT $1',
            [limit],
        );
        return result.rows;
    }
}
`,
            'src/app.ts': `import express from 'express';
import { config } from './config';
import { ConnectionPool } from './database/connection-pool';
import { UserService } from './services/user.service';
import { OrderService } from './services/order.service';
import { errorHandler } from './middleware/error-handler';
import logger from './utils/logger';

const pool = new ConnectionPool({ connectionString: config.DATABASE_URL });
const userService = new UserService(pool);
const orderService = new OrderService(pool);

const app = express();
app.use(express.json());

app.get('/users', async (req, res) => {
    const users = await userService.listUsers();
    res.json(users);
});

app.post('/orders', async (req, res) => {
    const order = await orderService.createOrder(req.body);
    res.json(order);
});

app.use(errorHandler);
app.listen(config.PORT, () => logger.info(\`Server on port \${config.PORT}\`));
`,
        },
    }),
);

// ── 3. null_check_already_handled (discard) ──
const CONFIG_PARSER_TS = `export interface AppConfig {
    port: number;
    host: string;
    dbUrl: string;
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
    return {
        port: parseInt(env.PORT || '3000', 10),
        host: env.HOST || 'localhost',
        dbUrl: env.DATABASE_URL,
    };
}
`;

const NULL_CHECK_SUGGESTION = {
    id: '1',
    suggestionContent:
        "Unsafe undefined propagation from `parseConfig()`. Line 12 assigns `env.DATABASE_URL` to `dbUrl` without a default value or null check. If the `DATABASE_URL` environment variable is missing, `dbUrl` becomes `undefined` (TypeScript does not enforce runtime type safety for process.env). When `dbUrl` is later passed to `new Pool({ connectionString: config.dbUrl })`, the pg driver interprets `undefined` as a request to connect using default parameters (localhost:5432, no auth), silently connecting to the wrong database in production. Concrete scenario: deploy to a new environment where DATABASE_URL is not set — the app starts successfully but reads/writes to the wrong database.",
    existingCode: 'dbUrl: env.DATABASE_URL,',
    improvedCode:
        "dbUrl: env.DATABASE_URL || (() => { throw new Error('DATABASE_URL is required'); })(),",
    oneSentenceSummary:
        'Missing null check — env.DATABASE_URL can be undefined, causing silent connection to wrong database',
    relevantLinesStart: 12,
    relevantLinesEnd: 12,
    label: 'bug_risk',
    severity: 'high',
};

scenarios.push(
    buildCase({
        scenario: 'null_check_already_handled',
        description:
            'Suggestion claims missing null check but validateConfig() called immediately after parseConfig() throws if dbUrl is missing.',
        expected: 'discard',
        filePath: 'src/utils/config-parser.ts',
        fileContent: CONFIG_PARSER_TS,
        patchWithLinesStr: `@@ -8,6 +8,6 @@
+        dbUrl: env.DATABASE_URL,`,
        suggestion: NULL_CHECK_SUGGESTION,
        repoFiles: {
            'src/utils/config-parser.ts': CONFIG_PARSER_TS,
            'src/app.ts': `import express from 'express';
import { parseConfig } from './utils/config-parser';
import { validateConfig } from './utils/config-validator';
import { errorHandler } from './middleware/error-handler';
import logger from './utils/logger';

const config = parseConfig(process.env);
validateConfig(config);

const app = express();
app.use(express.json());
app.use(errorHandler);
app.listen(config.port, () => logger.info(\`Server on port \${config.port}\`));
`,
            'src/utils/config-validator.ts': `import { AppConfig } from './config-parser';

export function validateConfig(config: AppConfig): void {
    if (!config.dbUrl) {
        throw new Error('DATABASE_URL is required but was not provided');
    }
    if (!config.host) {
        throw new Error('HOST is required');
    }
    if (isNaN(config.port) || config.port < 1 || config.port > 65535) {
        throw new Error(\`Invalid port: \${config.port}\`);
    }
}
`,
            'src/services/health.service.ts': `import { config } from '../config';

export class HealthService {
    async check(): Promise<{ status: string; uptime: number }> {
        return {
            status: 'ok',
            uptime: process.uptime(),
        };
    }
}
`,
            'src/utils/validators.ts': `export function isValidEmail(email: string): boolean {
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

export function isValidUUID(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export function sanitizeInput(input: string): string {
    return input.replace(/[<>&"']/g, '');
}
`,
        },
    }),
);

// ── 4. null_check_missing (no_changes) ──
scenarios.push(
    buildCase({
        scenario: 'null_check_missing',
        description:
            'Suggestion claims missing null check and there is NO validation anywhere — parseConfig result used directly.',
        expected: 'no_changes',
        filePath: 'src/utils/config-parser.ts',
        fileContent: CONFIG_PARSER_TS,
        patchWithLinesStr: `@@ -8,6 +8,6 @@
+        dbUrl: env.DATABASE_URL,`,
        suggestion: NULL_CHECK_SUGGESTION,
        repoFiles: {
            'src/utils/config-parser.ts': CONFIG_PARSER_TS,
            'src/app.ts': `import express from 'express';
import { parseConfig } from './utils/config-parser';
import { errorHandler } from './middleware/error-handler';
import logger from './utils/logger';

const config = parseConfig(process.env);

const app = express();
app.use(express.json());
app.use(errorHandler);
app.listen(config.port, () => logger.info(\`Server on port \${config.port}\`));
`,
            'src/database/client.ts': `import { Pool } from 'pg';
import { parseConfig } from '../utils/config-parser';

const config = parseConfig(process.env);
const pool = new Pool({ connectionString: config.dbUrl });

export default pool;
`,
            'src/services/startup.service.ts': `import pool from '../database/client';
import logger from '../utils/logger';

export async function startServices(): Promise<void> {
    try {
        await pool.query('SELECT 1');
        logger.info('Database connection verified');
    } catch (err) {
        logger.error('Failed to connect to database');
        throw err;
    }
}
`,
        },
    }),
);

// ── 5. wrong_algorithm_context_ok (discard) ──
const HASHER_TS = `import { createHash } from 'crypto';

export function hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}
`;

const WRONG_ALGO_SUGGESTION = {
    id: '1',
    suggestionContent:
        "Weak hashing algorithm for sensitive data. `hashContent()` uses `createHash('sha256')` (line 4), a fast cryptographic hash vulnerable to GPU-accelerated brute-force attacks. SHA-256 can compute ~10 billion hashes/second on modern hardware. If this function processes any user credentials, API keys, or secrets, an attacker with a database dump can recover plaintext values in minutes. The fix is to use `bcrypt` or `argon2` with a work factor, which adds intentional computational cost (~100ms per hash) making brute-force infeasible.",
    existingCode: "return createHash('sha256').update(content).digest('hex');",
    improvedCode: "import { hash } from 'bcrypt';\nreturn await hash(content, 12);",
    oneSentenceSummary:
        'Weak hash — SHA-256 is vulnerable to brute-force, should use bcrypt or argon2 for sensitive data',
    relevantLinesStart: 4,
    relevantLinesEnd: 4,
    label: 'security',
    severity: 'critical',
};

scenarios.push(
    buildCase({
        scenario: 'wrong_algorithm_context_ok',
        description:
            'Suggestion claims SHA-256 is insecure but hashContent is only used for file integrity checksums and cache keys — SHA-256 is fine for these purposes.',
        expected: 'discard',
        filePath: 'src/crypto/hasher.ts',
        fileContent: HASHER_TS,
        patchWithLinesStr: `@@ -3,3 +3,3 @@
+    return createHash('sha256').update(content).digest('hex');`,
        suggestion: WRONG_ALGO_SUGGESTION,
        repoFiles: {
            'src/crypto/hasher.ts': HASHER_TS,
            'src/services/file-integrity.service.ts': `import { hashContent } from '../crypto/hasher';

export class FileIntegrityService {
    async verifyFile(filePath: string, expectedHash: string): Promise<boolean> {
        const content = await fs.readFile(filePath, 'utf-8');
        const actualHash = hashContent(content);
        return actualHash === expectedHash;
    }

    async computeChecksum(filePath: string): Promise<string> {
        const content = await fs.readFile(filePath, 'utf-8');
        return hashContent(content);
    }
}
`,
            'src/services/cache.service.ts': `import { hashContent } from '../crypto/hasher';

export class CacheService {
    private cache = new Map<string, { value: any; expiresAt: number }>();

    getCacheKey(params: Record<string, string>): string {
        const serialized = JSON.stringify(params, Object.keys(params).sort());
        return \`cache:\${hashContent(serialized)}\`;
    }

    get(key: string): any | undefined {
        const entry = this.cache.get(key);
        if (!entry || Date.now() > entry.expiresAt) return undefined;
        return entry.value;
    }

    set(key: string, value: any, ttlMs: number): void {
        this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
}
`,
            'src/services/auth.service.ts': `import bcrypt from 'bcrypt';

export class AuthService {
    private readonly SALT_ROUNDS = 12;

    async register(email: string, password: string) {
        const passwordHash = await bcrypt.hash(password, this.SALT_ROUNDS);
        return this.userRepo.create({ email, passwordHash });
    }

    async login(email: string, password: string) {
        const user = await this.userRepo.findByEmail(email);
        if (!user) return null;
        const valid = await bcrypt.compare(password, user.passwordHash);
        return valid ? user : null;
    }
}
`,
        },
    }),
);

// ── 6. wrong_algorithm_passwords (no_changes) ──
scenarios.push(
    buildCase({
        scenario: 'wrong_algorithm_passwords',
        description:
            'Suggestion claims SHA-256 is insecure and hashContent IS used for password hashing in auth service.',
        expected: 'no_changes',
        filePath: 'src/crypto/hasher.ts',
        fileContent: HASHER_TS,
        patchWithLinesStr: `@@ -3,3 +3,3 @@
+    return createHash('sha256').update(content).digest('hex');`,
        suggestion: WRONG_ALGO_SUGGESTION,
        repoFiles: {
            'src/crypto/hasher.ts': HASHER_TS,
            'src/services/auth.service.ts': `import { hashContent } from '../crypto/hasher';

export class AuthService {
    async register(email: string, password: string) {
        const passwordHash = hashContent(password);
        return this.userRepo.create({ email, passwordHash });
    }

    async login(email: string, password: string) {
        const user = await this.userRepo.findByEmail(email);
        if (!user) return null;
        const inputHash = hashContent(password);
        return inputHash === user.passwordHash ? user : null;
    }
}
`,
            'src/services/file-integrity.service.ts': `import { hashContent } from '../crypto/hasher';

export class FileIntegrityService {
    async verifyFile(filePath: string, expectedHash: string): Promise<boolean> {
        const content = await fs.readFile(filePath, 'utf-8');
        const actualHash = hashContent(content);
        return actualHash === expectedHash;
    }
}
`,
            'src/utils/crypto.ts': `import { createHash, createHmac } from 'crypto';

export function hmacSign(data: string, secret: string): string {
    return createHmac('sha256', secret).update(data).digest('hex');
}

export function md5(content: string): string {
    return createHash('md5').update(content).digest('hex');
}
`,
        },
    }),
);

// ── 7. error_handling_caller_catches (discard) ──
const EMAIL_SERVICE_TS = `import { Transporter } from 'nodemailer';

export class EmailService {
    constructor(private transporter: Transporter) {}

    async sendEmail(to: string, subject: string, body: string): Promise<void> {
        await this.transporter.sendMail({
            from: 'noreply@app.com',
            to,
            subject,
            html: body,
        });
    }
}
`;

const ERROR_HANDLING_SUGGESTION = {
    id: '1',
    suggestionContent:
        "Unhandled rejection from `transporter.sendMail()`. Lines 7-12 await `this.transporter.sendMail()` without a try/catch block. If the SMTP server rejects the connection (DNS resolution failure, TLS handshake error, authentication failure), the rejection propagates as an unhandled promise rejection to the caller. In Node.js 16+, unhandled rejections terminate the process by default. Concrete scenario: SMTP server goes down during a deployment — every call to `sendEmail()` crashes the process, causing cascading failures across all request handlers that trigger emails.",
    existingCode: `await this.transporter.sendMail({
    from: 'noreply@app.com',
    to,
    subject,
    html: body,
});`,
    improvedCode: `try {
    await this.transporter.sendMail({
        from: 'noreply@app.com',
        to,
        subject,
        html: body,
    });
} catch (error) {
    logger.error('Failed to send email', { to, subject, error });
    throw new EmailDeliveryError(\`Failed to send email to \${to}\`, error);
}`,
    oneSentenceSummary:
        'Unhandled SMTP rejection — sendMail() failure propagates and crashes the process',
    relevantLinesStart: 7,
    relevantLinesEnd: 12,
    label: 'bug_risk',
    severity: 'high',
};

scenarios.push(
    buildCase({
        scenario: 'error_handling_caller_catches',
        description:
            'Suggestion claims unhandled sendMail rejection but all callers wrap sendEmail() in try/catch.',
        expected: 'discard',
        filePath: 'src/services/email.service.ts',
        fileContent: EMAIL_SERVICE_TS,
        patchWithLinesStr: `@@ -6,7 +6,7 @@
+    async sendEmail(to: string, subject: string, body: string): Promise<void> {
+        await this.transporter.sendMail({`,
        suggestion: ERROR_HANDLING_SUGGESTION,
        repoFiles: {
            'src/services/email.service.ts': EMAIL_SERVICE_TS,
            'src/controllers/auth.controller.ts': `import { EmailService } from '../services/email.service';
import { logError } from '../utils/logger';

export class AuthController {
    constructor(private emailService: EmailService) {}

    async forgotPassword(req: Request, res: Response) {
        const user = await this.userRepo.findByEmail(req.body.email);
        if (!user) return res.status(200).json({ message: 'If the email exists, a reset link was sent' });
        try {
            await this.emailService.sendEmail(
                user.email,
                'Password Reset',
                \`<a href="/reset?token=\${user.resetToken}">Reset password</a>\`,
            );
        } catch (error) {
            logError('auth.forgotPassword', error);
        }
        return res.status(200).json({ message: 'If the email exists, a reset link was sent' });
    }
}
`,
            'src/services/notification.service.ts': `import { EmailService } from './email.service';
import { logError } from '../utils/logger';

export class NotificationService {
    constructor(private emailService: EmailService) {}

    async notifyUser(userId: string, message: string): Promise<boolean> {
        const user = await this.userRepo.findById(userId);
        try {
            await this.emailService.sendEmail(user.email, 'Notification', message);
            return true;
        } catch (error) {
            logError('notification.send', error);
            return false;
        }
    }
}
`,
            'src/workers/queue-processor.ts': `import logger from '../utils/logger';

export class QueueProcessor {
    async processJob(job: Job): Promise<void> {
        try {
            switch (job.type) {
                case 'email':
                    await this.emailService.sendEmail(job.to, job.subject, job.body);
                    break;
                case 'webhook':
                    await this.webhookService.send(job.url, job.payload);
                    break;
            }
        } catch (error) {
            logger.error(\`Job \${job.id} failed\`, { error });
            await this.markFailed(job.id, error);
        }
    }
}
`,
            'test/services/email.service.test.ts': `import { EmailService } from '../../src/services/email.service';
import { createMockTransporter } from '../helpers/setup';

describe('EmailService', () => {
    it('should send email via transporter', async () => {
        const transporter = createMockTransporter();
        const service = new EmailService(transporter as any);

        await service.sendEmail('test@example.com', 'Test', '<p>Hello</p>');
        expect(transporter.sendMail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'test@example.com',
        }));
    });
});
`,
        },
    }),
);

// ── 8. error_handling_no_catch (no_changes) ──
scenarios.push(
    buildCase({
        scenario: 'error_handling_no_catch',
        description:
            'Suggestion claims unhandled sendMail rejection and callers do NOT wrap in try/catch — errors propagate unhandled.',
        expected: 'no_changes',
        filePath: 'src/services/email.service.ts',
        fileContent: EMAIL_SERVICE_TS,
        patchWithLinesStr: `@@ -6,7 +6,7 @@
+    async sendEmail(to: string, subject: string, body: string): Promise<void> {
+        await this.transporter.sendMail({`,
        suggestion: ERROR_HANDLING_SUGGESTION,
        repoFiles: {
            'src/services/email.service.ts': EMAIL_SERVICE_TS,
            'src/services/notification.service.ts': `import { EmailService } from './email.service';

export class NotificationService {
    constructor(private emailService: EmailService) {}

    async notifyUser(userId: string, message: string): Promise<void> {
        const user = await this.userRepo.findById(userId);
        await this.emailService.sendEmail(
            user.email,
            'Notification',
            message,
        );
    }

    async sendBulkNotifications(userIds: string[], message: string): Promise<void> {
        for (const userId of userIds) {
            await this.notifyUser(userId, message);
        }
    }
}
`,
            'src/workers/reminder.worker.ts': `import { EmailService } from '../services/email.service';

export async function sendReminders() {
    const overdueUsers = await db.query('SELECT * FROM users WHERE reminder_due < NOW()');
    for (const user of overdueUsers) {
        await emailService.sendEmail(user.email, 'Reminder', 'Your task is overdue');
    }
}
`,
        },
    }),
);

// ── 9. inconsistent_sync_framework_handles (discard) ──
const MEMORY_CACHE_TS = `export class MemoryCache<T> {
    private store = new Map<string, { value: T; expiresAt: number }>();

    get(key: string): T | undefined {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: T, ttlMs: number): void {
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    }

    delete(key: string): void {
        this.store.delete(key);
    }
}
`;

scenarios.push(
    buildCase({
        scenario: 'inconsistent_sync_framework_handles',
        description:
            'Suggestion claims race condition on Map but this is a single-threaded Node.js/Express app — no concurrency issue.',
        expected: 'discard',
        filePath: 'src/cache/memory-cache.ts',
        fileContent: MEMORY_CACHE_TS,
        patchWithLinesStr: `@@ -3,9 +3,9 @@
+    get(key: string): T | undefined {
+        const entry = this.store.get(key);`,
        suggestion: {
            id: '1',
            suggestionContent:
                "Race condition between `get()` and `set()` on shared `Map`. Lines 4-11 perform a non-atomic read-check-delete sequence: `get(key)` reads the entry, `Date.now() > entry.expiresAt` checks expiration, and `this.store.delete(key)` removes it. In a concurrent environment, a second thread could call `set(key, newValue)` between the `get()` and `delete()`, causing the `delete()` to remove the freshly written value. Concrete scenario: Thread A reads key 'session:123' and finds it expired. Thread B writes key 'session:123' with a new session. Thread A deletes key 'session:123', destroying the new session.",
            existingCode: `get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
        return undefined;
    }
    return entry.value;
}`,
            improvedCode: `get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
        return undefined;
    }
    return entry.value;
}`,
            oneSentenceSummary:
                'Race condition — non-atomic read-check-delete on Map allows concurrent set() to lose data',
            relevantLinesStart: 4,
            relevantLinesEnd: 11,
            label: 'bug_risk',
            severity: 'high',
        },
        repoFiles: {
            'src/cache/memory-cache.ts': MEMORY_CACHE_TS,
            'src/app.ts': `import express from 'express';
import { config } from './config';
import { MemoryCache } from './cache/memory-cache';
import { errorHandler } from './middleware/error-handler';
import logger from './utils/logger';

const app = express();
const cache = new MemoryCache<string>();

app.use(express.json());

app.get('/data/:key', (req, res) => {
    const cached = cache.get(req.params.key);
    if (cached) return res.json({ data: cached });
    res.status(404).json({ error: 'Not found' });
});

app.use(errorHandler);
app.listen(config.PORT, () => logger.info(\`Server on port \${config.PORT}\`));
`,
            'src/services/rate-limiter.ts': `export class RateLimiter {
    private requests = new Map<string, { count: number; resetAt: number }>();

    isAllowed(clientIp: string, maxRequests: number = 100, windowMs: number = 60000): boolean {
        const now = Date.now();
        const entry = this.requests.get(clientIp);

        if (!entry || now > entry.resetAt) {
            this.requests.set(clientIp, { count: 1, resetAt: now + windowMs });
            return true;
        }

        entry.count++;
        return entry.count <= maxRequests;
    }
}
`,
            'src/workers/index.ts': `import logger from '../utils/logger';

export function startScheduler() {
    setInterval(async () => {
        try {
            await processOverdueReminders();
        } catch (err) {
            logger.error('Scheduler tick failed', { error: err });
        }
    }, 60_000);

    logger.info('Scheduler started with 60s interval');
}

async function processOverdueReminders() {
    const reminders = await db.query('SELECT * FROM reminders WHERE due_at < NOW() AND sent = false');
    for (const reminder of reminders) {
        await sendReminderEmail(reminder);
        await db.query('UPDATE reminders SET sent = true WHERE id = $1', [reminder.id]);
    }
}
`,
        },
    }),
);

// ── 10. data_exposure_real (no_changes) ──
scenarios.push(
    buildCase({
        scenario: 'data_exposure_real',
        description:
            'Suggestion claims sensitive fields exposed in API response — controller returns full User object with passwordHash and internalNotes.',
        expected: 'no_changes',
        filePath: 'src/services/user.service.ts',
        fileContent: `import { User } from '../models/user.model';

export class UserService {
    async getUserProfile(userId: string): Promise<User> {
        const user = await this.userRepo.findById(userId);
        if (!user) throw new NotFoundError('User not found');
        return user;
    }
}
`,
        patchWithLinesStr: `@@ -3,6 +3,6 @@
+    async getUserProfile(userId: string): Promise<User> {
+        const user = await this.userRepo.findById(userId);`,
        suggestion: {
            id: '1',
            suggestionContent:
                "Sensitive field exposure in API response. `getUserProfile()` (line 4) returns the raw `User` entity from the repository, which includes `passwordHash` and `internalNotes` fields (as defined in the `User` interface). When the controller passes this object to `res.json()`, Express serializes ALL enumerable properties, including sensitive fields. Any client calling `GET /users/:id` receives the password hash in the response body. Concrete scenario: attacker calls the public profile endpoint, receives `{ ..., passwordHash: '$2b$12$...', internalNotes: 'VIP customer, approved for $50k credit line' }`, enabling offline password cracking and information leakage.",
            existingCode: 'return user;',
            improvedCode:
                'const { passwordHash, internalNotes, ...safeUser } = user;\nreturn safeUser;',
            oneSentenceSummary:
                'Data exposure — getUserProfile returns full User entity including passwordHash and internalNotes to API consumers',
            relevantLinesStart: 7,
            relevantLinesEnd: 7,
            label: 'security',
            severity: 'critical',
        },
        repoFiles: {
            'src/services/user.service.ts': `import { User } from '../models/user.model';

export class UserService {
    async getUserProfile(userId: string): Promise<User> {
        const user = await this.userRepo.findById(userId);
        if (!user) throw new NotFoundError('User not found');
        return user;
    }
}
`,
            'src/models/user.model.ts': `export interface User {
    id: string;
    email: string;
    name: string;
    passwordHash: string;
    internalNotes: string;
    role: string;
    createdAt: Date;
}
`,
            'src/controllers/user.controller.ts': `import { UserService } from '../services/user.service';

export class UserController {
    constructor(private userService: UserService) {}

    async getProfile(req: Request, res: Response) {
        const user = await this.userService.getUserProfile(req.userId);
        return res.json(user);
    }

    async getPublicProfile(req: Request, res: Response) {
        const user = await this.userService.getUserProfile(req.params.id);
        return res.json(user);
    }
}
`,
            'src/dto/user.dto.ts': `export interface UserProfileDTO {
    id: string;
    email: string;
    name: string;
    role: string;
}

export function toUserProfileDTO(user: any): UserProfileDTO {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
    };
}
`,
            'src/middleware/auth.middleware.ts': `import jwt from 'jsonwebtoken';
import { config } from '../config';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const payload = jwt.verify(token, config.JWT_SECRET) as { userId: string };
        req.userId = payload.userId;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
`,
        },
    }),
);

// ── 11. race_condition_mitigated (discard) ──
const INVENTORY_SERVICE_TS = `import { DatabaseClient } from '../database/client';

export class InventoryService {
    constructor(private db: DatabaseClient) {}

    async getStock(productId: string): Promise<number> {
        const result = await this.db.query(
            'SELECT quantity FROM inventory WHERE product_id = $1',
            [productId],
        );
        return result.rows[0]?.quantity ?? 0;
    }

    async setStock(productId: string, quantity: number): Promise<void> {
        await this.db.query(
            'UPDATE inventory SET quantity = $1 WHERE product_id = $2',
            [quantity, productId],
        );
    }

    async updateStock(productId: string, delta: number): Promise<number> {
        const currentStock = await this.getStock(productId);
        const newStock = currentStock + delta;
        if (newStock < 0) {
            throw new Error(\`Insufficient stock for product \${productId}\`);
        }
        await this.setStock(productId, newStock);
        return newStock;
    }
}
`;

const RACE_CONDITION_SUGGESTION = {
    id: '1',
    suggestionContent:
        "Race condition / lost update on inventory stock. Lines 22-28 perform a read-modify-write sequence: `getStock()` reads current stock, adds `delta` locally, then `setStock()` writes back. If two concurrent `updateStock()` calls execute for the same product, both read the same `currentStock` value (e.g., 10), both subtract their quantities, and the second write overwrites the first. Concrete scenario: stock=10, two orders for quantity=3 execute concurrently. Both read currentStock=10, compute 7, write 7. Final stock is 7 instead of 4 — 3 units of inventory vanished. Should use an atomic SQL UPDATE or advisory locking.",
    existingCode: `async updateStock(productId: string, delta: number): Promise<number> {
    const currentStock = await this.getStock(productId);
    const newStock = currentStock + delta;
    if (newStock < 0) {
        throw new Error(\`Insufficient stock for product \${productId}\`);
    }
    await this.setStock(productId, newStock);
    return newStock;
}`,
    improvedCode: `async updateStock(productId: string, delta: number): Promise<number> {
    const result = await this.db.query(
        'UPDATE inventory SET quantity = quantity + $1 WHERE product_id = $2 AND quantity + $1 >= 0 RETURNING quantity',
        [delta, productId],
    );
    if (result.rowCount === 0) {
        throw new Error(\`Insufficient stock for product \${productId}\`);
    }
    return result.rows[0].quantity;
}`,
    oneSentenceSummary:
        'Race condition — read-modify-write on inventory without locking allows concurrent updates to lose stock decrements',
    relevantLinesStart: 22,
    relevantLinesEnd: 30,
    label: 'bug_risk',
    severity: 'critical',
};

const advisoryLockCallerCode = (serviceName, method, args) => `import { InventoryService } from './inventory.service';
import { DatabaseClient } from '../database/client';

export class ${serviceName} {
    constructor(private db: DatabaseClient, private inventory: InventoryService) {}

    async ${method}(${args}): Promise<void> {
        const client = await this.db.getClient();
        try {
            await client.query('SELECT pg_advisory_lock($1)', [this.lockKey(productId)]);
            await this.inventory.updateStock(productId, ${method === 'fulfillOrder' ? '-quantity' : 'quantity'});
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [this.lockKey(productId)]);
            client.release();
        }
    }

    private lockKey(productId: string): number {
        let hash = 0;
        for (const ch of productId) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
        return Math.abs(hash);
    }
}
`;

scenarios.push(
    buildCase({
        scenario: 'race_condition_mitigated',
        description:
            'Suggestion claims race condition in updateStock() but ALL callers acquire pg_advisory_lock before calling it.',
        expected: 'discard',
        filePath: 'src/services/inventory.service.ts',
        fileContent: INVENTORY_SERVICE_TS,
        patchWithLinesStr: `@@ -21,9 +21,9 @@
+    async updateStock(productId: string, delta: number): Promise<number> {
+        const currentStock = await this.getStock(productId);`,
        suggestion: RACE_CONDITION_SUGGESTION,
        repoFiles: {
            'src/services/inventory.service.ts': INVENTORY_SERVICE_TS,
            'src/services/order-fulfillment.service.ts': advisoryLockCallerCode(
                'OrderFulfillmentService',
                'fulfillOrder',
                'orderId: string, productId: string, quantity: number',
            ),
            'src/services/restock.service.ts': advisoryLockCallerCode(
                'RestockService',
                'receiveShipment',
                'productId: string, quantity: number',
            ),
            'src/database/client.ts': `import { Pool } from 'pg';
import { config } from '../config';

const pool = new Pool({ connectionString: config.DATABASE_URL });

export class DatabaseClient {
    async query(sql: string, params?: any[]) {
        return pool.query(sql, params);
    }

    async getClient() {
        return pool.connect();
    }
}

export default new DatabaseClient();
`,
        },
    }),
);

// ── 12. race_condition_real (no_changes) ──
scenarios.push(
    buildCase({
        scenario: 'race_condition_real',
        description:
            'Suggestion claims race condition in updateStock() and callers do NOT use any locking — race is real.',
        expected: 'no_changes',
        filePath: 'src/services/inventory.service.ts',
        fileContent: INVENTORY_SERVICE_TS,
        patchWithLinesStr: `@@ -21,9 +21,9 @@
+    async updateStock(productId: string, delta: number): Promise<number> {
+        const currentStock = await this.getStock(productId);`,
        suggestion: RACE_CONDITION_SUGGESTION,
        repoFiles: {
            'src/services/inventory.service.ts': INVENTORY_SERVICE_TS,
            'src/services/order-fulfillment.service.ts': `import { InventoryService } from './inventory.service';

export class OrderFulfillmentService {
    constructor(private inventory: InventoryService) {}

    async fulfillOrder(orderId: string, productId: string, quantity: number): Promise<void> {
        const newStock = await this.inventory.updateStock(productId, -quantity);
        await this.orderRepo.update(orderId, { status: 'fulfilled', remainingStock: newStock });
    }
}
`,
            'src/services/restock.service.ts': `import { InventoryService } from './inventory.service';

export class RestockService {
    constructor(private inventory: InventoryService) {}

    async receiveShipment(productId: string, quantity: number): Promise<void> {
        await this.inventory.updateStock(productId, quantity);
    }
}
`,
            'src/api/routes/inventory.routes.ts': `import { Router } from 'express';

const router = Router();

router.post('/orders/:id/fulfill', async (req, res) => {
    const { productId, quantity } = req.body;
    await orderFulfillmentService.fulfillOrder(req.params.id, productId, quantity);
    res.json({ status: 'fulfilled' });
});

router.post('/inventory/restock', async (req, res) => {
    const { productId, quantity } = req.body;
    await restockService.receiveShipment(productId, quantity);
    res.json({ status: 'restocked' });
});

export default router;
`,
            'src/database/client.ts': `import { Pool } from 'pg';
import { config } from '../config';

const pool = new Pool({ connectionString: config.DATABASE_URL });

export class DatabaseClient {
    async query(sql: string, params?: any[]) {
        return pool.query(sql, params);
    }

    async getClient() {
        return pool.connect();
    }
}

export default new DatabaseClient();
`,
        },
    }),
);

// ── 13. redundant_work_mitigated (discard) ──
const PERMISSION_SERVICE_TS = `export class PermissionService {
    async getUserPermissions(userId: string): Promise<string[]> {
        const result = await this.db.query(
            \`SELECT p.name FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             JOIN user_roles ur ON rp.role_id = ur.role_id
             WHERE ur.user_id = $1\`,
            [userId],
        );
        return result.rows.map(r => r.name);
    }
}
`;

const REDUNDANT_WORK_SUGGESTION = {
    id: '1',
    suggestionContent:
        "Redundant database queries inside loop. The `filterAccessibleItems` method calls `this.permissionService.getUserPermissions(userId)` on every iteration of the items loop. `getUserPermissions()` executes a 3-table JOIN query (`permissions`, `role_permissions`, `user_roles`) on each call. For a batch of 100 items, this executes 100 identical database queries returning the same permission set. The result should be fetched once before the loop and reused. Concrete scenario: processing 500 items triggers 500 identical DB round-trips, adding ~2 seconds of latency at ~4ms per query.",
    existingCode: `const userPermissions = await this.permissionService.getUserPermissions(userId);
const accessible: Item[] = [];

for (const item of items) {
    const required = this.getRequiredPermission(item.category);
    if (userPermissions.includes(required)) {
        accessible.push(item);
    }
}`,
    improvedCode: `const userPermissions = await this.permissionService.getUserPermissions(userId);
const permSet = new Set(userPermissions);
const accessible = items.filter(item => permSet.has(this.getRequiredPermission(item.category)));`,
    oneSentenceSummary:
        'Redundant DB queries — getUserPermissions() called per item in loop instead of once before loop',
    relevantLinesStart: 8,
    relevantLinesEnd: 13,
    label: 'performance',
    severity: 'high',
};

scenarios.push(
    buildCase({
        scenario: 'redundant_work_mitigated',
        description:
            'Suggestion claims getUserPermissions is called inside loop but ACTUALLY it is called ONCE before the loop.',
        expected: 'discard',
        filePath: 'src/services/item-access.service.ts',
        fileContent: `import { PermissionService } from './permission.service';

export class ItemAccessService {
    constructor(private permissionService: PermissionService) {}

    async filterAccessibleItems(userId: string, items: Item[]): Promise<Item[]> {
        const userPermissions = await this.permissionService.getUserPermissions(userId);
        const accessible: Item[] = [];

        for (const item of items) {
            const required = this.getRequiredPermission(item.category);
            if (userPermissions.includes(required)) {
                accessible.push(item);
            }
        }

        return accessible;
    }

    private getRequiredPermission(category: string): string {
        const permMap: Record<string, string> = {
            public: 'read:items',
            internal: 'read:internal',
            restricted: 'read:restricted',
            admin: 'admin:items',
        };
        return permMap[category] || 'read:items';
    }
}
`,
        patchWithLinesStr: `@@ -6,12 +6,12 @@
+    async filterAccessibleItems(userId: string, items: Item[]): Promise<Item[]> {
+        const userPermissions = await this.permissionService.getUserPermissions(userId);`,
        suggestion: REDUNDANT_WORK_SUGGESTION,
        repoFiles: {
            'src/services/item-access.service.ts': `import { PermissionService } from './permission.service';

export class ItemAccessService {
    constructor(private permissionService: PermissionService) {}

    async filterAccessibleItems(userId: string, items: Item[]): Promise<Item[]> {
        const userPermissions = await this.permissionService.getUserPermissions(userId);
        const accessible: Item[] = [];

        for (const item of items) {
            const required = this.getRequiredPermission(item.category);
            if (userPermissions.includes(required)) {
                accessible.push(item);
            }
        }

        return accessible;
    }

    private getRequiredPermission(category: string): string {
        const permMap: Record<string, string> = {
            public: 'read:items',
            internal: 'read:internal',
            restricted: 'read:restricted',
            admin: 'admin:items',
        };
        return permMap[category] || 'read:items';
    }
}
`,
            'src/services/permission.service.ts': PERMISSION_SERVICE_TS,
        },
    }),
);

// ── 14. redundant_work_real (no_changes) ──
scenarios.push(
    buildCase({
        scenario: 'redundant_work_real',
        description:
            'Suggestion claims getUserPermissions is called inside loop and it IS inside the loop — redundant work is real.',
        expected: 'no_changes',
        filePath: 'src/services/item-access.service.ts',
        fileContent: `import { PermissionService } from './permission.service';

export class ItemAccessService {
    constructor(private permissionService: PermissionService) {}

    async filterAccessibleItems(userId: string, items: Item[]): Promise<Item[]> {
        const accessible: Item[] = [];

        for (const item of items) {
            const userPermissions = await this.permissionService.getUserPermissions(userId);
            const required = this.getRequiredPermission(item.category);
            if (userPermissions.includes(required)) {
                accessible.push(item);
            }
        }

        return accessible;
    }

    private getRequiredPermission(category: string): string {
        const permMap: Record<string, string> = {
            public: 'read:items',
            internal: 'read:internal',
            restricted: 'read:restricted',
            admin: 'admin:items',
        };
        return permMap[category] || 'read:items';
    }
}
`,
        patchWithLinesStr: `@@ -6,12 +6,12 @@
+    async filterAccessibleItems(userId: string, items: Item[]): Promise<Item[]> {
+        const accessible: Item[] = [];`,
        suggestion: {
            ...REDUNDANT_WORK_SUGGESTION,
            existingCode: `for (const item of items) {
    const userPermissions = await this.permissionService.getUserPermissions(userId);
    const required = this.getRequiredPermission(item.category);
    if (userPermissions.includes(required)) {
        accessible.push(item);
    }
}`,
        },
        repoFiles: {
            'src/services/item-access.service.ts': `import { PermissionService } from './permission.service';

export class ItemAccessService {
    constructor(private permissionService: PermissionService) {}

    async filterAccessibleItems(userId: string, items: Item[]): Promise<Item[]> {
        const accessible: Item[] = [];

        for (const item of items) {
            const userPermissions = await this.permissionService.getUserPermissions(userId);
            const required = this.getRequiredPermission(item.category);
            if (userPermissions.includes(required)) {
                accessible.push(item);
            }
        }

        return accessible;
    }

    private getRequiredPermission(category: string): string {
        const permMap: Record<string, string> = {
            public: 'read:items',
            internal: 'read:internal',
            restricted: 'read:restricted',
            admin: 'admin:items',
        };
        return permMap[category] || 'read:items';
    }
}
`,
            'src/services/permission.service.ts': PERMISSION_SERVICE_TS,
        },
    }),
);

// ═══════════════════════════════════════════════════════════════
// Write output
// ═══════════════════════════════════════════════════════════════

const outputPath = path.join(__dirname, 'safeguard_datasets/verify/agent_verification.jsonl');
const output = scenarios.map(s => JSON.stringify(s)).join('\n') + '\n';
fs.writeFileSync(outputPath, output, 'utf-8');

console.log(`Written ${scenarios.length} test cases to ${outputPath}`);

// Summary
for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const files = Object.keys(s.inputs.repoFixture).length;
    console.log(
        `  ${String(i + 1).padStart(2)}. ${s.metadata.scenario.padEnd(45)} ${s.metadata.expected_action.padEnd(12)} ${files} files`,
    );
}
