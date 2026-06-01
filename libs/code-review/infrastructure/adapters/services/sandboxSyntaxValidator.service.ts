import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '@kodus/flow';
import { Sandbox } from 'e2b';
import pLimit from 'p-limit';
import { ValidationCandidate } from '@libs/code-review/domain/types/astValidate.type';
import { shSingleQuote } from './shell-quote';

const PARSE_TIMEOUT_MS = 30_000;
const CONCURRENCY_LIMIT = 10;
const VALIDATE_DIR = '/tmp/validate';
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — only needs to survive through validation
const INSTALL_TIMEOUT_MS = 120_000; // 2 min — bun + kodus-graph install

@Injectable()
export class SandboxSyntaxValidator {
    private readonly logger = createLogger(SandboxSyntaxValidator.name);

    constructor(private readonly configService: ConfigService) {}

    /**
     * Validate syntax of merged code candidates by running kodus-graph parse
     * in a dedicated lightweight sandbox.
     * Returns a Set of candidate IDs that are syntactically valid.
     * If sandbox creation fails, returns all IDs (skip validation).
     */
    async validateFiles(
        candidates: ValidationCandidate[],
    ): Promise<Set<string>> {
        if (candidates.length === 0) {
            return new Set();
        }

        const apiKey = this.configService.get<string>('API_E2B_KEY');
        if (!apiKey) {
            this.logger.warn({
                message: `[SYNTAX] No API_E2B_KEY configured, skipping syntax validation for ${candidates.length} candidates`,
                context: SandboxSyntaxValidator.name,
            });
            return new Set(candidates.map((c) => c.id));
        }

        let sandbox: Sandbox | null = null;
        try {
            sandbox = await this.createLightweightSandbox(apiKey);
            await this.installKodusGraph(sandbox);

            const limit = pLimit(CONCURRENCY_LIMIT);
            const tasks = candidates.map((candidate) =>
                limit(() => this.validateSingle(sandbox!, candidate)),
            );

            const results = await Promise.allSettled(tasks);
            const validIds = new Set<string>();

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    validIds.add(result.value);
                }
            }

            this.logger.log({
                message: `[SYNTAX] Validated ${candidates.length} candidates: ${validIds.size} valid, ${candidates.length - validIds.size} invalid`,
                context: SandboxSyntaxValidator.name,
            });

            return validIds;
        } catch (error) {
            this.logger.warn({
                message: `[SYNTAX] Validation sandbox failed, skipping syntax validation for ${candidates.length} candidates`,
                context: SandboxSyntaxValidator.name,
                error,
            });
            return new Set(candidates.map((c) => c.id));
        } finally {
            if (sandbox) {
                try {
                    await sandbox.kill();
                } catch { /* ignore cleanup errors */ }
            }
        }
    }

    private async createLightweightSandbox(apiKey: string): Promise<Sandbox> {
        const templateId = this.configService.get<string>('API_E2B_TEMPLATE_ID');
        if (templateId) {
            try {
                return await Sandbox.create(templateId, {
                    timeoutMs: SANDBOX_TIMEOUT_MS,
                    apiKey,
                    metadata: { stage: 'syntax-validation' },
                });
            } catch {
                this.logger.warn({
                    message: `[SYNTAX] Template sandbox creation failed, falling back to default`,
                    context: SandboxSyntaxValidator.name,
                });
            }
        }
        return await Sandbox.create({
            timeoutMs: SANDBOX_TIMEOUT_MS,
            apiKey,
            metadata: { stage: 'syntax-validation' },
        });
    }

    private async installKodusGraph(sandbox: Sandbox): Promise<void> {
        const check = await sandbox.commands.run(
            'export PATH="$HOME/.bun/bin:$PATH" && kodus-graph --version 2>/dev/null || true',
            { timeoutMs: 5_000 },
        );

        if ((check.stdout || '').trim()) {
            this.logger.log({
                message: `[SYNTAX] kodus-graph already available: ${(check.stdout || '').trim()}`,
                context: SandboxSyntaxValidator.name,
            });
            return;
        }

        const result = await sandbox.commands.run(
            [
                'which bun > /dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1)',
                'export PATH="$HOME/.bun/bin:$PATH"',
                'bun install -g @kodus/kodus-graph@latest 2>&1',
            ].join(' && '),
            { timeoutMs: INSTALL_TIMEOUT_MS },
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph install failed (exit=${result.exitCode}): ${(result.stderr || result.stdout || '').slice(0, 500)}`,
            );
        }
    }

    private async validateSingle(
        sandbox: Sandbox,
        candidate: ValidationCandidate,
    ): Promise<string | null> {
        const workDir = `${VALIDATE_DIR}/${candidate.id}`;
        const filePath = candidate.filePath;
        const fullPath = `${workDir}/${filePath}`;
        const resultPath = `${workDir}/result.json`;

        try {
            const code = Buffer.from(candidate.encodedData, 'base64').toString('utf-8');

            const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
            await sandbox.commands.run(`mkdir -p ${shSingleQuote(dir)}`, {
                timeoutMs: 5_000,
            });
            await sandbox.files.write(fullPath, code);

            const result = await sandbox.commands.run(
                `export PATH="$HOME/.bun/bin:$PATH" && kodus-graph parse --files ${shSingleQuote(filePath)} --repo-dir ${shSingleQuote(workDir)} --out ${shSingleQuote(resultPath)}`,
                { timeoutMs: PARSE_TIMEOUT_MS },
            );

            if (result.exitCode !== 0) {
                this.logger.warn({
                    message: `[SYNTAX] kodus-graph parse failed for ${filePath} (exit=${result.exitCode})`,
                    context: SandboxSyntaxValidator.name,
                    metadata: { candidateId: candidate.id, stderr: result.stderr?.substring(0, 200) },
                });
                return null;
            }

            const jsonContent = await sandbox.files.read(resultPath);
            const parsed = JSON.parse(jsonContent);
            const parseErrors = parsed?.metadata?.parse_errors ?? 0;
            const extractErrors = parsed?.metadata?.extract_errors ?? 0;

            if (parseErrors > 0 || extractErrors > 0) {
                this.logger.log({
                    message: `[SYNTAX] Invalid syntax: ${filePath} (parse_errors=${parseErrors}, extract_errors=${extractErrors})`,
                    context: SandboxSyntaxValidator.name,
                    metadata: { candidateId: candidate.id },
                });
                return null;
            }

            return candidate.id;
        } catch (error) {
            this.logger.warn({
                message: `[SYNTAX] Validation error for ${filePath}, marking as invalid`,
                context: SandboxSyntaxValidator.name,
                error,
                metadata: { candidateId: candidate.id },
            });
            return null;
        } finally {
            try {
                await sandbox.commands.run(`rm -rf ${shSingleQuote(workDir)}`, { timeoutMs: 5_000 });
            } catch { /* ignore cleanup errors */ }
        }
    }
}
