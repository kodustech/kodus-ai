/**
 * What the self-hosted dev scripts write is what the runtime runs (#1161).
 *
 * `setup.sh` used to know only the OpenAI-named vars, so a Gemini install went
 * through Gemini's OpenAI endpoint, which drops the thought signatures Gemini 3
 * requires on multi-turn tool calls. The runtime now takes a stated provider
 * (`API_LLM_PROVIDER`, see .env.example); these specs drive the real scripts
 * and hand what they produce to the runtime's own resolver.
 *
 * Each script runs from a copy in a temp dir, with a temp HOME and an env that
 * holds only PATH, so neither the repo nor the developer's own config or keys
 * are read or written.
 */
import '@libs/llm/providers';
import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeEnvLLMConfig } from '@libs/llm/env-llm-config';
import { resolveDeclaredEnvProvider } from '@libs/llm/env-declared-provider';

const SELFHOSTED = __dirname;

interface Sandbox {
    home: string;
    scripts: string;
    bin: string;
}

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sandbox(): Sandbox {
    const root = mkdtempSync(join(tmpdir(), 'selfhosted-llm-'));
    roots.push(root);
    const home = join(root, 'home');
    const scripts = join(root, 'repo', 'scripts', 'selfhosted');
    const bin = join(root, 'bin');
    for (const dir of [home, scripts, bin]) mkdirSync(dir, { recursive: true });
    for (const file of ['setup.sh', '_common.sh']) {
        copyFileSync(join(SELFHOSTED, file), join(scripts, file));
    }
    return { home, scripts, bin };
}

function writeConfig(box: Sandbox, lines: string[]): void {
    mkdirSync(join(box.home, '.kodus-dev'), { recursive: true });
    writeFileSync(
        join(box.home, '.kodus-dev', 'config'),
        `${lines.join('\n')}\n`,
    );
}

function scriptEnv(box: Sandbox, extra: Record<string, string> = {}) {
    return {
        PATH: `${box.bin}:${process.env.PATH ?? ''}`,
        HOME: box.home,
        ...extra,
    };
}

/** Runs setup.sh answering each prompt with a line of `answers` ('' = Enter). */
function runSetup(box: Sandbox, answers: string[]): Record<string, string> {
    // The trailing "n" declines the direnv offer when direnv is installed.
    execFileSync('bash', [join(box.scripts, 'setup.sh')], {
        input: `${[...answers, 'n'].join('\n')}\n`,
        env: scriptEnv(box),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseEnvLines(
        readFileSync(join(box.home, '.kodus-dev', 'config'), 'utf8'),
    );
}

function parseEnvLines(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) env[match[1]] = match[2];
    }
    return env;
}

/** The LLM vars `_common.sh` hands provision.sh for the VM `.env`. */
function vmLlmEnv(
    box: Sandbox,
    callerEnv: Record<string, string> = {},
): Record<string, string> {
    const out = execFileSync(
        'bash',
        ['-c', `. "${join(box.scripts, '_common.sh')}" && selfhosted_llm_env`],
        { env: scriptEnv(box, callerEnv), stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString();
    return parseEnvLines(out);
}

const DO_TOKEN = 'dop_fake';
const INSTALLER = '/nonexistent/kodus-installer';

describe('selfhosted setup.sh writes the LLM config the runtime runs', () => {
    it('a Gemini install resolves to the native google_gemini provider (#1161)', () => {
        const box = sandbox();

        const config = runSetup(box, [
            DO_TOKEN,
            '', // license
            '', // GitHub token
            'google_gemini',
            'gemini-3.5-flash',
            'AIza-fake-studio-key',
            '', // embeddings OpenAI key
            INSTALLER,
        ]);

        const described = describeEnvLLMConfig(config);
        expect(described).toMatchObject({
            configured: true,
            providerId: 'google_gemini',
            providerSource: 'declared',
            model: 'gemini-3.5-flash',
        });
        const declared = resolveDeclaredEnvProvider(config);
        expect(declared.kind).toBe('declared');
        expect(declared.kind === 'declared' && declared.config.apiKey).toBe(
            'AIza-fake-studio-key',
        );
        // Gemini's OpenAI endpoint is the path that drops thought signatures.
        expect(config.API_OPENAI_FORCE_BASE_URL ?? '').toBe('');
    });

    it('a re-run over a pre-#1161 Gemini config moves it to the native provider', () => {
        const box = sandbox();
        writeConfig(box, [
            `DIGITALOCEAN_TOKEN=${DO_TOKEN}`,
            'API_OPEN_AI_API_KEY=AIza-fake-studio-key',
            'API_OPENAI_FORCE_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/',
            'API_LLM_PROVIDER_MODEL=gemini-3.5-flash',
            `KODUS_INSTALLER_PATH=${INSTALLER}`,
        ]);

        // Enter on every prompt keeps what the config had.
        const config = runSetup(box, ['', '', '', '', '', '', '', '']);

        expect(describeEnvLLMConfig(config)).toMatchObject({
            configured: true,
            providerId: 'google_gemini',
            providerSource: 'declared',
            model: 'gemini-3.5-flash',
        });
        expect(config.API_LLM_API_KEY).toBe('AIza-fake-studio-key');
    });

    it('a re-run over the old team default (Kimi on Moonshot) keeps the same upstream', () => {
        const box = sandbox();
        writeConfig(box, [
            `DIGITALOCEAN_TOKEN=${DO_TOKEN}`,
            'API_OPEN_AI_API_KEY=sk-fake-moonshot',
            'API_OPENAI_FORCE_BASE_URL=https://api.moonshot.ai/v1',
            'API_LLM_PROVIDER_MODEL=kimi-k2.6',
            `KODUS_INSTALLER_PATH=${INSTALLER}`,
        ]);
        const before = describeEnvLLMConfig(
            parseEnvLines(
                readFileSync(join(box.home, '.kodus-dev', 'config'), 'utf8'),
            ),
        );

        const config = runSetup(box, ['', '', '', '', '', '', '', '', '']);

        expect(before).toMatchObject({
            providerId: 'openai_compatible',
            baseUrl: 'https://api.moonshot.ai/v1',
        });
        expect(describeEnvLLMConfig(config)).toMatchObject({
            configured: true,
            providerId: 'openai_compatible',
            providerSource: 'declared',
            baseUrl: 'https://api.moonshot.ai/v1',
            model: 'kimi-k2.6',
        });
        expect(config.API_LLM_API_KEY).toBe('sk-fake-moonshot');
        // Also the embeddings key: kept as it was.
        expect(config.API_OPEN_AI_API_KEY).toBe('sk-fake-moonshot');
    });

    it('a first setup on all defaults still lands on the team default upstream', () => {
        const box = sandbox();

        const config = runSetup(box, [
            DO_TOKEN,
            '',
            '',
            '', // provider: default
            '', // model: default
            'sk-fake-moonshot',
            '', // base URL: default
            '',
            INSTALLER,
        ]);

        expect(describeEnvLLMConfig(config)).toMatchObject({
            configured: true,
            providerId: 'openai_compatible',
            providerSource: 'declared',
            baseUrl: 'https://api.moonshot.ai/v1',
            model: 'kimi-k2.6',
        });
    });

    it('a native OpenAI setup also gives embeddings its key, as before', () => {
        const box = sandbox();

        const config = runSetup(box, [
            DO_TOKEN,
            '',
            '',
            'openai',
            'gpt-5.4',
            'sk-fake-openai',
            '', // base URL: api.openai.com
            '', // embeddings key: defaults to the OpenAI key
            INSTALLER,
        ]);

        expect(describeEnvLLMConfig(config)).toMatchObject({
            configured: true,
            providerId: 'openai',
            providerSource: 'declared',
        });
        expect(config.API_OPEN_AI_API_KEY).toBe('sk-fake-openai');
    });

    it('does not offer a key saved for another provider when the provider changes', () => {
        const box = sandbox();
        writeConfig(box, [
            `DIGITALOCEAN_TOKEN=${DO_TOKEN}`,
            'API_LLM_PROVIDER=openai_compatible',
            'API_LLM_PROVIDER_MODEL=kimi-k2.6',
            'API_LLM_API_KEY=sk-fake-moonshot',
            'API_LLM_BASE_URL=https://api.moonshot.ai/v1',
            `KODUS_INSTALLER_PATH=${INSTALLER}`,
        ]);

        const config = runSetup(box, [
            '',
            '',
            '',
            'google_gemini',
            'gemini-3.5-flash',
            '', // key: nothing to keep for google_gemini
            '',
            '',
        ]);

        expect(config.API_LLM_PROVIDER).toBe('google_gemini');
        expect(config.API_LLM_API_KEY).toBe('');
        expect(config.API_LLM_BASE_URL).toBe('');
    });

    it('--show lists the LLM config without printing the key', () => {
        const box = sandbox();
        writeConfig(box, [
            'API_LLM_PROVIDER=google_gemini',
            'API_LLM_PROVIDER_MODEL=gemini-3.5-flash',
            'API_LLM_API_KEY=AIza-fake-studio-key-0123',
        ]);

        const out = execFileSync(
            'bash',
            [join(box.scripts, 'setup.sh'), '--show'],
            { env: scriptEnv(box), stdio: ['pipe', 'pipe', 'pipe'] },
        )
            .toString()
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b\[[0-9;]*m/g, '');

        expect(out).toMatch(/API_LLM_PROVIDER\s+google_gemini/);
        expect(out).not.toContain('AIza-fake-studio-key-0123');
    });

    it('rejects a provider the runtime cannot run', () => {
        const box = sandbox();

        expect(() =>
            runSetup(box, [DO_TOKEN, '', '', 'gemini', 'gemini-3.5-flash']),
        ).toThrow();
    });
});

describe('selfhosted _common.sh carries the LLM config to the VM', () => {
    it('hands provision.sh the declared provider, so the VM runs native Gemini', () => {
        const box = sandbox();
        writeConfig(box, [
            'API_LLM_PROVIDER=google_gemini',
            'API_LLM_PROVIDER_MODEL=gemini-3.5-flash',
            'API_LLM_API_KEY=AIza-fake-studio-key',
            'API_LLM_REASONING_EFFORT=high',
        ]);

        const vmEnv = vmLlmEnv(box);

        expect(describeEnvLLMConfig(vmEnv)).toMatchObject({
            configured: true,
            providerId: 'google_gemini',
            providerSource: 'declared',
            reasoningEffort: 'high',
        });
    });

    it('hands a config that was never re-run the same legacy vars as before', () => {
        const box = sandbox();
        writeConfig(box, [
            'API_OPEN_AI_API_KEY=sk-fake-moonshot',
            'API_OPENAI_FORCE_BASE_URL=https://api.moonshot.ai/v1',
            'API_LLM_PROVIDER_MODEL=kimi-k2.6',
        ]);

        expect(vmLlmEnv(box)).toEqual({
            API_OPEN_AI_API_KEY: 'sk-fake-moonshot',
            API_OPENAI_FORCE_BASE_URL: 'https://api.moonshot.ai/v1',
            API_LLM_PROVIDER_MODEL: 'kimi-k2.6',
        });
    });

    it('lets the caller override the provider inline, and resolves a 1Password key', () => {
        const box = sandbox();
        writeConfig(box, [
            'API_LLM_PROVIDER=openai_compatible',
            'API_LLM_PROVIDER_MODEL=gemini-3.5-flash',
            'API_LLM_API_KEY=op://Vault/kodus/gemini-key',
        ]);
        // A stand-in `op` CLI: answers the one reference, nothing else.
        const op = join(box.bin, 'op');
        writeFileSync(
            op,
            '#!/usr/bin/env bash\n[ "$1 $2 $3" = "read --no-newline op://Vault/kodus/gemini-key" ] && printf AIza-from-vault && exit 0\nexit 1\n',
        );
        chmodSync(op, 0o755);

        const vmEnv = vmLlmEnv(box, { API_LLM_PROVIDER: 'google_gemini' });

        expect(vmEnv.API_LLM_PROVIDER).toBe('google_gemini');
        expect(vmEnv.API_LLM_API_KEY).toBe('AIza-from-vault');
    });
});
