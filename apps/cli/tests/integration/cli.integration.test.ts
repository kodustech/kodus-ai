import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from './mock-server.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'dist/index.js');

let mockServer: MockServer;
let tmpHome: string;
let gitRepoDir: string;

interface CliResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

function parseFirstJsonObject(output: string): any {
    const start = output.indexOf('{');
    if (start === -1) {
        throw new Error('No JSON object found in CLI output');
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < output.length; i++) {
        const ch = output[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === '{') {
            depth += 1;
            continue;
        }

        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return JSON.parse(output.slice(start, i + 1));
            }
        }
    }

    throw new Error('Incomplete JSON object in CLI output');
}

async function runCli(
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
    try {
        const { stdout, stderr } = await execFileAsync(
            'node',
            [CLI_PATH, ...args],
            {
                cwd: opts.cwd ?? gitRepoDir,
                env: {
                    PATH: process.env.PATH,
                    HOME: tmpHome,
                    KODUS_API_URL: mockServer.url,
                    NO_COLOR: '1',
                    FORCE_COLOR: '0',
                    NODE_NO_WARNINGS: '1',
                    ...opts.env,
                },
                timeout: 30_000,
            },
        );
        return { stdout, stderr, exitCode: 0 };
    } catch (error: any) {
        return {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? '',
            exitCode: typeof error.code === 'number' ? error.code : 1,
        };
    }
}

async function createTempGitRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-test-repo-'));
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], {
        cwd: dir,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    return dir;
}

beforeAll(async () => {
    // 1. Isolated HOME so ~/.kodus is temp
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-test-home-'));
    const kodusDir = path.join(tmpHome, '.kodus');
    await fs.mkdir(kodusDir, { recursive: true });

    // 2. Team key config
    await fs.writeFile(
        path.join(kodusDir, 'config.json'),
        JSON.stringify({
            teamKey: 'kodus_test_key',
            teamName: 'Test Team',
            organizationName: 'Test Org',
        }),
    );

    // 3. Git repo with uncommitted changes
    gitRepoDir = await createTempGitRepo();
    await fs.writeFile(
        path.join(gitRepoDir, 'test.ts'),
        'let x = 1;\nlet y = 2;\n',
    );
    await execFileAsync('git', ['add', '.'], { cwd: gitRepoDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], {
        cwd: gitRepoDir,
    });
    await fs.writeFile(
        path.join(gitRepoDir, 'test.ts'),
        'let x = 1;\nlet y = 2;\nlet z = 3;\n',
    );

    // 4. Mock API server
    mockServer = await startMockServer();
});

afterAll(async () => {
    await mockServer?.close();
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
    if (gitRepoDir) await fs.rm(gitRepoDir, { recursive: true, force: true });
});

beforeEach(() => {
    mockServer.reset();
});

// ---------------------------------------------------------------------------
// Smoke tests — no API needed
// ---------------------------------------------------------------------------
describe('CLI smoke', () => {
    it('prints version', async () => {
        const pkg = JSON.parse(
            await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
        );
        const { stdout, exitCode } = await runCli(['--version']);
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe(pkg.version);
    });

    it('prints help with main commands', async () => {
        const { stdout, exitCode } = await runCli(['--help']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('review');
        expect(stdout).toContain('auth');
        expect(stdout).toContain('schema');
    });

    it('prints config help with remote entrypoints', async () => {
        const { stdout, exitCode } = await runCli(['config', '--help']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('-r, --remote [repository]');
        expect(stdout).toContain('remote [repository]');
        expect(stdout).not.toContain('repo [repository]');
    });

    it('prints review subcommand help', async () => {
        const { stdout, exitCode } = await runCli(['review', '--help']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('--staged');
        expect(stdout).toContain('--fast');
        expect(stdout).toContain('--prompt-only');
    });
});

// ---------------------------------------------------------------------------
// Top-level utility commands
// ---------------------------------------------------------------------------
describe('utility commands', () => {
    it('prints consolidated status', async () => {
        const { stdout, stderr, exitCode } = await runCli(['status']);
        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output).toContain('Kodus Status');
        expect(output).toContain('Version:');
        expect(output).toContain('Auth:');
        expect(output).toContain('Repository:');
        expect(output).toContain('Pre-push hook:');
        expect(output).toContain('Decision hooks:');
    });

    it('lists bundled skills via skills list', async () => {
        const { stdout, stderr, exitCode } = await runCli(['skills', 'list']);
        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output).toContain('Available bundled skills');
        expect(output).toContain('kodus-review');
    });

    it('exposes full skill lifecycle commands', async () => {
        const { stdout, exitCode } = await runCli(['skills', '--help']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('install');
        expect(stdout).toContain('uninstall');
        expect(stdout).toContain('sync');
        expect(stdout).toContain('resync');
    });
});

// ---------------------------------------------------------------------------
// Review command — full round-trip through mock server
// ---------------------------------------------------------------------------
describe('review integration', () => {
    it('returns agent envelope in review agent mode', async () => {
        const { stdout, exitCode } = await runCli([
            'review',
            '--fast',
            '--agent',
        ]);
        expect(exitCode).toBe(0);

        const json = parseFirstJsonObject(stdout);
        expect(json.ok).toBe(true);
        expect(json.command).toBe('review');
        expect(json.error).toBeNull();
        expect(json.meta.mode).toBe('agent');
        expect(json.meta.schemaVersion).toBe('1.0');
        expect(json.data).toHaveProperty('summary');
        expect(json.data).toHaveProperty('issues');
    });

    it('supports --fields projection for review in agent mode', async () => {
        const { stdout, exitCode } = await runCli([
            'review',
            '--fast',
            '--agent',
            '--fields',
            'summary,issues.file,issues.line',
        ]);
        expect(exitCode).toBe(0);

        const json = parseFirstJsonObject(stdout);
        expect(json.ok).toBe(true);
        expect(json.data.summary).toBeTruthy();
        expect(Array.isArray(json.data.issues)).toBe(true);
        expect(json.data.issues[0]).toHaveProperty('file');
        expect(json.data.issues[0]).toHaveProperty('line');
        expect(json.data.issues[0]).not.toHaveProperty('severity');
    });

    it('returns JSON review result', async () => {
        const { stdout, exitCode } = await runCli([
            'review',
            '--fast',
            '--format',
            'json',
        ]);
        expect(exitCode).toBe(0);

        const json = parseFirstJsonObject(stdout);
        expect(json).toHaveProperty('summary');
        expect(json).toHaveProperty('issues');
        expect(json.issues).toHaveLength(2);
        expect(json.filesAnalyzed).toBe(1);
        expect(json.duration).toBe(1234);
    });

    it('suppresses verbose trace lines when quiet mode is enabled', async () => {
        const { stdout, stderr, exitCode } = await runCli([
            'review',
            '--fast',
            '--format',
            'json',
            '--verbose',
            '--quiet',
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).not.toContain('[verbose]');
        expect(stderr).not.toContain('[verbose]');
        expect(stdout).not.toContain('[API]');
        expect(stderr).not.toContain('[API]');
        expect(stderr).not.toContain('Checking authentication');
        expect(stderr).not.toContain('Review complete');
    });

    it('keeps stdout clean JSON when verbose is enabled', async () => {
        const { stdout, stderr, exitCode } = await runCli([
            'review',
            '--fast',
            '--format',
            'json',
            '--verbose',
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).not.toContain('[verbose]');
        expect(stdout).not.toContain('[API]');
        expect(stderr).toContain('[verbose]');

        const json = parseFirstJsonObject(stdout);
        expect(json).toHaveProperty('summary');
    });

    it('sends X-Team-Key header when using team key', async () => {
        await runCli(['review', '--fast', '--format', 'json']);

        const req = mockServer.requests.find((r) => r.url === '/cli/review');
        expect(req).toBeDefined();
        expect(req!.headers['x-team-key']).toBe('kodus_test_key');
        // Should NOT have Authorization header
        expect(req!.headers['authorization']).toBeUndefined();
    });

    it('sends diff in request body', async () => {
        await runCli(['review', '--fast', '--format', 'json']);

        const req = mockServer.requests.find((r) => r.url === '/cli/review');
        expect(req).toBeDefined();
        expect(req!.body).toHaveProperty('diff');
        expect(req!.body.diff).toContain('let z = 3');
    });

    it('reports "No changes" when working tree is clean', async () => {
        const cleanRepo = await createTempGitRepo();
        await fs.writeFile(path.join(cleanRepo, 'file.ts'), 'const x = 1;\n');
        await execFileAsync('git', ['add', '.'], { cwd: cleanRepo });
        await execFileAsync('git', ['commit', '-m', 'init'], {
            cwd: cleanRepo,
        });

        try {
            const { stdout, stderr } = await runCli(
                ['review', '--format', 'json'],
                { cwd: cleanRepo },
            );
            const output = stdout + stderr;
            expect(output).toContain('No changes to review');
        } finally {
            await fs.rm(cleanRepo, { recursive: true, force: true });
        }
    });

    it('returns NO_CHANGES envelope in review agent mode when repo is clean', async () => {
        const cleanRepo = await createTempGitRepo();
        await fs.writeFile(path.join(cleanRepo, 'file.ts'), 'const x = 1;\n');
        await execFileAsync('git', ['add', '.'], { cwd: cleanRepo });
        await execFileAsync('git', ['commit', '-m', 'init'], {
            cwd: cleanRepo,
        });

        try {
            const { stdout, exitCode } = await runCli(['review', '--agent'], {
                cwd: cleanRepo,
            });
            expect(exitCode).toBe(0);
            const json = parseFirstJsonObject(stdout);
            expect(json.ok).toBe(false);
            expect(json.error.code).toBe('NO_CHANGES');
        } finally {
            await fs.rm(cleanRepo, { recursive: true, force: true });
        }
    });

    it('respects --staged flag (only staged diff)', async () => {
        await fs.writeFile(
            path.join(gitRepoDir, 'staged.ts'),
            'const staged = true;\n',
        );
        await execFileAsync('git', ['add', 'staged.ts'], { cwd: gitRepoDir });

        try {
            const { exitCode } = await runCli([
                'review',
                '--staged',
                '--fast',
                '--format',
                'json',
            ]);
            expect(exitCode).toBe(0);

            const req = mockServer.requests.find(
                (r) => r.url === '/cli/review',
            );
            expect(req).toBeDefined();
            // staged diff should contain the new file, NOT the unstaged test.ts change
            expect(req!.body.diff).toContain('staged');
        } finally {
            await execFileAsync('git', ['reset', 'HEAD', 'staged.ts'], {
                cwd: gitRepoDir,
            }).catch(() => {});
            await fs.unlink(path.join(gitRepoDir, 'staged.ts')).catch(() => {});
        }
    });

    it('outputs markdown format', async () => {
        const { stdout, exitCode } = await runCli([
            'review',
            '--fast',
            '--format',
            'markdown',
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Found 2 issues');
    });

    it('suppresses spinner output for pr suggestions when quiet mode is enabled', async () => {
        const { stdout, stderr, exitCode } = await runCli([
            '--quiet',
            'pr',
            'suggestions',
            '--pr-url',
            'https://github.com/org/repo/pull/42',
            '--format',
            'json',
        ]);

        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('');
        expect(stderr).not.toContain('Fetching pull request suggestions');
        expect(stderr).not.toContain('Suggestions fetched');
    });

    it('returns agent envelope for pr suggestions', async () => {
        const { stdout, exitCode } = await runCli([
            '--agent',
            'pr',
            'suggestions',
            '--pr-url',
            'https://github.com/org/repo/pull/42',
        ]);

        expect(exitCode).toBe(0);
        const json = parseFirstJsonObject(stdout);
        expect(json.ok).toBe(true);
        expect(json.command).toBe('pr suggestions');
        expect(json.data).toHaveProperty('issues');
    });

    it('returns INVALID_INPUT for invalid pr-number in agent mode', async () => {
        const { stdout, exitCode } = await runCli([
            '--agent',
            'pr',
            'suggestions',
            '--pr-number',
            'abc',
            '--repo-id',
            'repo-1',
        ]);

        expect(exitCode).toBe(1);
        const json = parseFirstJsonObject(stdout);
        expect(json.ok).toBe(false);
        expect(json.error.code).toBe('INVALID_INPUT');
    });

    it('supports --fields projection for pr suggestions in agent mode', async () => {
        const { stdout, exitCode } = await runCli([
            '--agent',
            'pr',
            'suggestions',
            '--pr-url',
            'https://github.com/org/repo/pull/42',
            '--fields',
            'summary,issues.file,issues.line',
        ]);

        expect(exitCode).toBe(0);
        const json = parseFirstJsonObject(stdout);
        expect(json.ok).toBe(true);
        expect(json.data.summary).toBeTruthy();
        expect(json.data.issues[0]).toHaveProperty('file');
        expect(json.data.issues[0]).toHaveProperty('line');
        expect(json.data.issues[0]).not.toHaveProperty('severity');
    });
});

describe('schema integration', () => {
    it('outputs top-level command schema in JSON format', async () => {
        const { stdout, exitCode } = await runCli([
            'schema',
            '--format',
            'json',
        ]);
        expect(exitCode).toBe(0);

        const json = parseFirstJsonObject(stdout);
        expect(json).toHaveProperty('name', 'kodus');
        expect(Array.isArray(json.commands)).toBe(true);
        expect(json.commands.some((c: any) => c.name === 'review')).toBe(true);
        expect(json.commands.some((c: any) => c.name === 'pr')).toBe(true);
    });

    it('preserves full command path for nested command schema', async () => {
        const { stdout, exitCode } = await runCli([
            'schema',
            '--command',
            'pr suggestions',
            '--agent',
        ]);
        expect(exitCode).toBe(0);

        const json = parseFirstJsonObject(stdout);
        expect(json.data.path).toBe('pr suggestions');
        expect(json.data.name).toBe('suggestions');
    });
});

describe('business validation integration', () => {
    it('does not advertise remote PR flags in help', async () => {
        const { stdout, exitCode } = await runCli([
            'pr',
            'business-validation',
            '--help',
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).not.toContain('--pr-url');
        expect(stdout).not.toContain('--pr-number');
        expect(stdout).toContain('--staged');
        expect(stdout).toContain('--branch');
    });

    it('rejects removed remote PR flags', async () => {
        const { stderr, exitCode } = await runCli([
            'pr',
            'business-validation',
            '--pr-url',
            'https://github.com/org/repo/pull/42',
        ]);

        expect(exitCode).toBe(1);
        expect(stderr).toContain('Unknown option: `--pr-url`.');
        expect(stderr).toContain(
            'Run `kodus pr --help` to see available options.',
        );
    });

    it('supports dry-run for local business validation payload', async () => {
        const { stdout, exitCode } = await runCli([
            'pr',
            'business-validation',
            '--task-id',
            'KC-1441',
            '--dry-run',
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain('/cli/business-validation');
        expect(stdout).toContain('"taskId": "KC-1441"');
        expect(stdout).toContain('"diff":');
        expect(stdout).not.toContain('"prUrl"');
        expect(stdout).not.toContain('"prNumber"');
    });
});

// ---------------------------------------------------------------------------
// Auth status — team key and trial paths
// ---------------------------------------------------------------------------
describe('auth status integration', () => {
    it('shows team key mode', async () => {
        const { stdout, stderr, exitCode } = await runCli(['auth', 'status']);
        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output).toContain('Team Key');
        expect(output).toContain('Test Org');
        expect(output).toContain('Test Team');
    });

    it('shows trial mode when no auth configured', async () => {
        const noAuthHome = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-noauth-'),
        );

        try {
            const { stdout, stderr, exitCode } = await runCli(
                ['auth', 'status'],
                {
                    env: { HOME: noAuthHome },
                },
            );
            expect(exitCode).toBe(0);
            const output = stdout + stderr;
            expect(output).toContain('Trial');
            expect(output).toContain('2/5');
        } finally {
            await fs.rm(noAuthHome, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Hook commands — install, status, uninstall
// ---------------------------------------------------------------------------
describe('hook integration', () => {
    it('kodus hook install --agent returns structured error outside git repo', async () => {
        const nonRepoDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-non-repo-'),
        );

        try {
            const { stdout, exitCode } = await runCli(
                ['hook', 'install', '--agent'],
                { cwd: nonRepoDir },
            );

            expect(exitCode).toBe(1);
            const json = parseFirstJsonObject(stdout);
            expect(json.ok).toBe(false);
            expect(json.command).toBe('hook install');
            expect(json.error.code).toBe('NOT_IN_GIT_REPO');
        } finally {
            await fs.rm(nonRepoDir, { recursive: true, force: true });
        }
    });

    it('kodus hook install --dry-run does not create pre-push hook', async () => {
        const hookPath = path.join(gitRepoDir, '.git', 'hooks', 'pre-push');
        await fs.unlink(hookPath).catch(() => {});

        const { stdout, stderr, exitCode } = await runCli([
            'hook',
            'install',
            '--dry-run',
            '--force',
        ]);

        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output.toLowerCase()).toContain('dry run');
        await expect(fs.access(hookPath)).rejects.toThrow();
    });

    it('kodus hook install creates pre-push hook', async () => {
        const { stdout, stderr, exitCode } = await runCli([
            'hook',
            'install',
            '--force',
        ]);
        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output).toContain('installed');

        const hookPath = path.join(gitRepoDir, '.git', 'hooks', 'pre-push');
        const content = await fs.readFile(hookPath, 'utf-8');
        expect(content).toContain('# kodus-hook');
        expect(content).toContain('--fail-on critical');
    });

    it('kodus hook status shows installed', async () => {
        // Install first
        await runCli(['hook', 'install', '--force']);

        const { stdout, stderr, exitCode } = await runCli(['hook', 'status']);
        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output).toContain('installed');
        expect(output).toContain('critical');
    });

    it('kodus hook uninstall removes the hook', async () => {
        // Install first
        await runCli(['hook', 'install', '--force']);

        const { stdout, stderr, exitCode } = await runCli([
            'hook',
            'uninstall',
        ]);
        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output).toContain('removed');

        const hookPath = path.join(gitRepoDir, '.git', 'hooks', 'pre-push');
        await expect(fs.access(hookPath)).rejects.toThrow();
    });

    it('kodus hook uninstall --agent returns structured error outside git repo', async () => {
        const nonRepoDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-non-repo-'),
        );

        try {
            const { stdout, exitCode } = await runCli(
                ['hook', 'uninstall', '--agent'],
                { cwd: nonRepoDir },
            );

            expect(exitCode).toBe(1);
            const json = parseFirstJsonObject(stdout);
            expect(json.ok).toBe(false);
            expect(json.command).toBe('hook uninstall');
            expect(json.error.code).toBe('NOT_IN_GIT_REPO');
        } finally {
            await fs.rm(nonRepoDir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Decision commands — enable and capture
// ---------------------------------------------------------------------------
describe('decisions integration', () => {
    it('kodus decisions enable configures .claude/settings.json and ~/.codex/config.toml', async () => {
        const { stdout, stderr, exitCode } = await runCli([
            'decisions',
            'enable',
            '--agents',
            'claude,codex',
        ]);
        expect(exitCode).toBe(0);
        const output = stdout + stderr;
        expect(output).toContain('Decisions enabled');

        const claudeSettingsPath = path.join(
            gitRepoDir,
            '.claude',
            'settings.json',
        );
        const claudeSettings = JSON.parse(
            await fs.readFile(claudeSettingsPath, 'utf-8'),
        );

        expect(claudeSettings).toHaveProperty('hooks');
        expect(claudeSettings.hooks).toHaveProperty('UserPromptSubmit');
        expect(claudeSettings.hooks).toHaveProperty('Stop');

        const userPromptSubmitJson = JSON.stringify(
            claudeSettings.hooks.UserPromptSubmit,
        );
        const stopJson = JSON.stringify(claudeSettings.hooks.Stop);
        expect(userPromptSubmitJson).toContain(
            'kodus decisions capture --capture-agent claude-compatible --event user-prompt-submit',
        );
        expect(stopJson).toContain(
            'kodus decisions capture --capture-agent claude-compatible --event stop',
        );

        const codexConfigPath = path.join(tmpHome, '.codex', 'config.toml');
        const codexConfig = await fs.readFile(codexConfigPath, 'utf-8');
        expect(codexConfig).toContain(
            'notify = ["kodus", "decisions", "capture", "--capture-agent", "codex", "--event", "stop"]',
        );
    });

    it('kodus decisions capture exits cleanly for non-stop events (no local storage)', async () => {
        const payload = JSON.stringify({
            session_id: 'session-1',
            turn_id: 'turn-1',
            prompt: 'Use idempotent cache key',
            last_assistant_message: 'Done with fallback behavior',
        });

        const { exitCode } = await runCli([
            'decisions',
            'capture',
            payload,
            '--agent',
            'codex',
            '--event',
            'agent-turn-complete',
            '--summary',
            'architectural decision',
        ]);
        expect(exitCode).toBe(0);

        // No local file should be created — capture only sends to API on stop
        const memoryDir = path.join(gitRepoDir, '.kody', 'pr');
        await expect(fs.access(memoryDir)).rejects.toThrow();
    });

    it('kodus decisions capture exits cleanly with claude-compatible agent and Cursor env vars', async () => {
        const payload = JSON.stringify({
            session_id: 'session-2',
            prompt: 'add retry with backoff',
        });

        const { exitCode } = await runCli(
            [
                'decisions',
                'capture',
                payload,
                '--agent',
                'claude-compatible',
                '--event',
                'user-prompt-submit',
            ],
            {
                env: {
                    CURSOR_VERSION: '1.0.0',
                },
            },
        );
        expect(exitCode).toBe(0);

        // No local file should be created — capture only sends to API on stop
        const memoryDir = path.join(gitRepoDir, '.kody', 'pr');
        await expect(fs.access(memoryDir)).rejects.toThrow();
    });

    it('kodus decisions disable --agent returns structured error outside git repo', async () => {
        const nonRepoDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-non-repo-'),
        );

        try {
            const { stdout, exitCode } = await runCli(
                ['decisions', 'disable', '--agent'],
                { cwd: nonRepoDir },
            );

            expect(exitCode).toBe(1);
            const json = parseFirstJsonObject(stdout);
            expect(json.ok).toBe(false);
            expect(json.command).toBe('decisions disable');
            expect(json.error.code).toBe('NOT_IN_GIT_REPO');
        } finally {
            await fs.rm(nonRepoDir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Review --fail-on flag
// ---------------------------------------------------------------------------
describe('review --fail-on integration', () => {
    it('exits with code 1 when issues meet threshold', async () => {
        // Mock server returns issues with severity 'warning' and 'error'
        const { exitCode } = await runCli([
            'review',
            '--fast',
            '--format',
            'json',
            '--fail-on',
            'warning',
        ]);
        expect(exitCode).toBe(1);
    });

    it('exits with code 0 when no issues meet threshold', async () => {
        // Mock server returns 'warning' and 'error' severity issues
        // Using --fail-on critical means neither meets threshold
        const { exitCode } = await runCli([
            'review',
            '--fast',
            '--format',
            'json',
            '--fail-on',
            'critical',
        ]);
        expect(exitCode).toBe(0);
    });
});
