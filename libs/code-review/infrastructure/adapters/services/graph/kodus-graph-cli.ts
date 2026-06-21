import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { shSingleQuote } from '../shell-quote';

export const KODUS_GRAPH_VERSION = '0.2.19';

export const KODUS_GRAPH_TIMEOUTS = {
    install: 120_000,
    parseAll: 600_000,
    parseFiles: 300_000,
    context: 60_000,
};

const BUN_PATH_PREFIX =
    'export PATH="$HOME/.bun/bin:$PATH" 2>/dev/null || true';

/**
 * Thin wrapper around the `kodus-graph` CLI. Owns install/parse/context
 * invocations so both the baseline indexer and the PR-level context service
 * share the same semantics (version, timeouts, local-vs-E2B install logic).
 */
@Injectable()
export class KodusGraphCli {
    private readonly logger = createLogger(KodusGraphCli.name);

    async install(sandbox: SandboxInstance): Promise<void> {
        const check = await sandbox.run(
            [
                BUN_PATH_PREFIX,
                'which kodus-graph 2>/dev/null && kodus-graph --version 2>/dev/null || true',
            ].join(' && '),
            { timeoutMs: 5_000 },
        );

        const output = (check.stdout || '').trim();
        const binaryFound = output.includes('/kodus-graph');
        const installedVersion = output.split('\n').pop()?.trim() || '';

        if (binaryFound && KODUS_GRAPH_VERSION === 'latest') {
            this.logger.log({
                message: `[KODUS-GRAPH] Found pre-installed binary (version: ${installedVersion || 'unknown'}), skipping install`,
                context: KodusGraphCli.name,
            });
            return;
        }

        if (installedVersion && installedVersion === KODUS_GRAPH_VERSION) {
            this.logger.log({
                message: `[KODUS-GRAPH] Version ${installedVersion} already installed, skipping`,
                context: KodusGraphCli.name,
            });
            return;
        }

        const installCmd =
            sandbox.type === 'local'
                ? `bun install -g --force @kodus/kodus-graph@${KODUS_GRAPH_VERSION} 2>&1`
                : [
                      'which bun > /dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1)',
                      'export PATH="$HOME/.bun/bin:$PATH"',
                      `bun install -g @kodus/kodus-graph@${KODUS_GRAPH_VERSION} 2>&1`,
                  ].join(' && ');

        const result = await sandbox.run(installCmd, {
            timeoutMs: KODUS_GRAPH_TIMEOUTS.install,
        });

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph install failed (exit=${result.exitCode}): ${(result.stderr || result.stdout || '').slice(0, 500)}`,
            );
        }
    }

    async parseAll(
        sandbox: SandboxInstance,
        options: {
            outPath: string;
            excludePatterns?: string[];
            timeoutMs?: number;
        },
    ): Promise<{ stderr: string }> {
        const {
            outPath,
            excludePatterns = [],
            timeoutMs = KODUS_GRAPH_TIMEOUTS.parseAll,
        } = options;
        const outDir = dirname(outPath);
        const excludeFlags = excludePatterns
            .map((p) => `--exclude ${shSingleQuote(p)}`)
            .join(' ');

        const cmd =
            `kodus-graph parse --all --repo-dir . --out ${shSingleQuote(outPath)} ${excludeFlags}`.trim();

        const result = await sandbox.run(
            [
                BUN_PATH_PREFIX,
                `cd ${sandbox.repoDir}`,
                `mkdir -p ${shSingleQuote(outDir)}`,
                cmd,
            ].join(' && '),
            { timeoutMs },
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph parse --all failed (exit=${result.exitCode}): ${(result.stderr || '').slice(0, 500)}`,
            );
        }

        return { stderr: result.stderr || '' };
    }

    async parseFiles(
        sandbox: SandboxInstance,
        files: string[],
        options: {
            outPath: string;
            repoDir?: string;
            timeoutMs?: number;
        },
    ): Promise<void> {
        const {
            outPath,
            repoDir = '.',
            timeoutMs = KODUS_GRAPH_TIMEOUTS.parseFiles,
        } = options;
        const outDir = dirname(outPath);
        const filesArg = quoteFiles(files);

        const result = await sandbox.run(
            [
                BUN_PATH_PREFIX,
                `cd ${sandbox.repoDir}`,
                `mkdir -p ${shSingleQuote(outDir)}`,
                `kodus-graph parse --files ${filesArg} --repo-dir ${shSingleQuote(repoDir)} --out ${shSingleQuote(outPath)}`,
            ].join(' && '),
            { timeoutMs },
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph parse --files failed (exit=${result.exitCode}): ${(result.stderr || '').slice(0, 500)}`,
            );
        }
    }

    async context(
        sandbox: SandboxInstance,
        files: string[],
        options: {
            outPath: string;
            graphPath?: string;
            diffPath?: string;
            timeoutMs?: number;
        },
    ): Promise<void> {
        const {
            outPath,
            graphPath,
            diffPath,
            timeoutMs = KODUS_GRAPH_TIMEOUTS.context,
        } = options;
        const outDir = dirname(outPath);
        const filesArg = quoteFiles(files);
        const graphArg = graphPath
            ? ` --graph ${shSingleQuote(graphPath)}`
            : '';
        const diffArg = diffPath ? ` --diff ${shSingleQuote(diffPath)}` : '';
        const cmd = `kodus-graph context --files ${filesArg}${graphArg}${diffArg} --repo-dir . --format xml --out ${shSingleQuote(outPath)}`;

        const result = await sandbox.run(
            [
                BUN_PATH_PREFIX,
                `cd ${sandbox.repoDir}`,
                `mkdir -p ${shSingleQuote(outDir)}`,
                cmd,
            ].join(' && '),
            { timeoutMs },
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph context failed (exit=${result.exitCode}): ${(result.stderr || '').slice(0, 500)}`,
            );
        }
    }
}

function quoteFiles(files: string[]): string {
    return files.map(shSingleQuote).join(' ');
}

function dirname(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '.' : path.slice(0, idx) || '.';
}
