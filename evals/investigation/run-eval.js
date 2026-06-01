#!/usr/bin/env node

const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const EVAL_DIR = __dirname;
const BASE_CONFIG = path.join(EVAL_DIR, 'promptfoo.yaml');
const TEMP_CONFIG = path.join(EVAL_DIR, '.promptfoo.generated.yaml');
const TEMP_TESTS = path.join(EVAL_DIR, '.promptfoo.generated.tests.json');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');
const RUNTIME_ARTIFACTS = [
    path.join(RESULTS_DIR, 'last-output.json'),
    path.join(RESULTS_DIR, 'last-assertion.json'),
    path.join(RESULTS_DIR, 'last-error.json'),
];

const DEFAULT_API_KEY_ENVS = {
    google: 'API_GOOGLE_AI_API_KEY',
    anthropic: 'API_ANTHROPIC_API_KEY',
    openai: 'API_OPEN_AI_API_KEY',
    'openai-compatible': 'API_OPEN_AI_API_KEY',
    openrouter: 'API_OPENROUTER_KEY',
};

const MODEL_PRESETS = {
    'gemini-2.5-flash': {
        provider: 'google',
        model: 'gemini-2.5-flash',
        label: 'gemini-2.5-flash-investigation',
    },
    'gemini-2.5-pro': {
        provider: 'google',
        model: 'gemini-2.5-pro',
        label: 'gemini-2.5-pro-investigation',
    },
    'gemini-3.1-pro': {
        provider: 'google',
        model: 'gemini-3.1-pro-preview',
        label: 'gemini-3.1-pro-investigation',
    },
    'claude-sonnet-4-5': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        label: 'claude-sonnet-4-5-investigation',
    },
    'gpt-5.4': {
        provider: 'openai',
        model: 'gpt-5.4',
        label: 'gpt-5.4-investigation',
    },
    'gpt-5.4-mini': {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        label: 'gpt-5.4-mini-investigation',
    },
    'kimi-k2.5-moonshot': {
        provider: 'openai-compatible',
        model: 'kimi-k2.5',
        apiKeyEnv: 'API_MOONSHOT_API_KEY',
        baseURL: 'https://api.moonshot.ai/v1',
        label: 'kimi-k2.5-moonshot-investigation',
    },
    'kimi-k2.5': {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        baseURL: 'https://openrouter.ai/api/v1',
        label: 'kimi-k2.5-investigation',
    },
    'kimi-k2.5-openrouter-moonshot': {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        baseURL: 'https://openrouter.ai/api/v1',
        providerOrder: ['moonshot'],
        allowFallbacks: false,
        label: 'kimi-k2.5-openrouter-moonshot-investigation',
    },
    'glm-5': {
        provider: 'openrouter',
        model: 'z-ai/glm-5',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        baseURL: 'https://openrouter.ai/api/v1',
        label: 'glm-5-investigation',
    },
};

function resolveNpxInvocation() {
    const npmCliPath = path.join(
        path.dirname(process.execPath),
        '..',
        'lib',
        'node_modules',
        'npm',
        'bin',
        'npx-cli.js',
    );

    if (fs.existsSync(npmCliPath)) {
        return {
            command: process.execPath,
            argsPrefix: [npmCliPath],
        };
    }

    return {
        command: 'npx',
        argsPrefix: [],
    };
}

function defaultApiKeyEnv(provider) {
    return DEFAULT_API_KEY_ENVS[provider] || 'API_GOOGLE_AI_API_KEY';
}

function defaultBaseUrl(provider) {
    if (provider === 'openrouter') {
        return 'https://openrouter.ai/api/v1';
    }

    return undefined;
}

function parseKeyValueEntries(entries, flagName) {
    if (!entries || entries.length === 0) return undefined;

    const parsed = {};
    for (const entry of entries) {
        const separator = entry.indexOf('=');
        if (separator <= 0) {
            throw new Error(
                `${flagName} entries must be in key=value format. Received: ${entry}`,
            );
        }

        const key = entry.slice(0, separator).trim();
        const value = entry.slice(separator + 1).trim();
        if (!key) {
            throw new Error(`${flagName} key cannot be empty. Received: ${entry}`);
        }

        parsed[key] = value;
    }

    return parsed;
}

function normalizeProviderConfig(config) {
    const provider = config.provider;
    const model = config.model;

    if (!provider) {
        throw new Error('Provider config is missing "provider"');
    }

    if (!model) {
        throw new Error('Provider config is missing "model"');
    }

    return {
        provider,
        model,
        apiKeyEnv: config.apiKeyEnv || defaultApiKeyEnv(provider),
        ...(config.baseURL || defaultBaseUrl(provider)
            ? { baseURL: config.baseURL || defaultBaseUrl(provider) }
            : {}),
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.queryParams ? { queryParams: config.queryParams } : {}),
        ...(Array.isArray(config.providerOrder) && config.providerOrder.length > 0
            ? { providerOrder: config.providerOrder }
            : {}),
        ...(typeof config.allowFallbacks === 'boolean'
            ? { allowFallbacks: config.allowFallbacks }
            : {}),
        ...(typeof config.requireParameters === 'boolean'
            ? { requireParameters: config.requireParameters }
            : {}),
        label:
            config.label || `${provider}:${model}`.replace(/[^\w.-]+/g, '-'),
    };
}

function resolvePreset(name) {
    const preset = MODEL_PRESETS[name];
    if (!preset) {
        throw new Error(
            `Unknown preset: ${name}. Available presets: ${Object.keys(
                MODEL_PRESETS,
            ).join(', ')}`,
        );
    }

    return normalizeProviderConfig(preset);
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const options = {
        dataset: 'smoke.json',
        noCache: false,
        listDatasets: false,
        listPresets: false,
        all: false,
        presets: [],
        provider: null,
        model: null,
        label: null,
        apiKeyEnv: null,
        baseURL: null,
        headers: [],
        queryParams: [],
        providerOrder: [],
        allowFallbacks: null,
        requireParameters: null,
        extraArgs: [],
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];

        if (arg === '--dataset') {
            options.dataset = args[i + 1] || options.dataset;
            i += 1;
            continue;
        }

        if (arg === '--no-cache') {
            options.noCache = true;
            continue;
        }

        if (arg === '--list-datasets') {
            options.listDatasets = true;
            continue;
        }

        if (arg === '--list-presets') {
            options.listPresets = true;
            continue;
        }

        if (arg === '--all') {
            options.all = true;
            continue;
        }

        if (arg === '--preset') {
            options.presets.push(args[i + 1]);
            i += 1;
            continue;
        }

        if (arg === '--provider') {
            options.provider = args[i + 1] || null;
            i += 1;
            continue;
        }

        if (arg === '--model') {
            options.model = args[i + 1] || null;
            i += 1;
            continue;
        }

        if (arg === '--label') {
            options.label = args[i + 1] || null;
            i += 1;
            continue;
        }

        if (arg === '--api-key-env') {
            options.apiKeyEnv = args[i + 1] || null;
            i += 1;
            continue;
        }

        if (arg === '--base-url') {
            options.baseURL = args[i + 1] || null;
            i += 1;
            continue;
        }

        if (arg === '--header') {
            options.headers.push(args[i + 1] || '');
            i += 1;
            continue;
        }

        if (arg === '--query-param') {
            options.queryParams.push(args[i + 1] || '');
            i += 1;
            continue;
        }

        if (arg === '--provider-order') {
            options.providerOrder.push(args[i + 1] || '');
            i += 1;
            continue;
        }

        if (arg === '--no-provider-fallbacks') {
            options.allowFallbacks = false;
            continue;
        }

        if (arg === '--allow-provider-fallbacks') {
            options.allowFallbacks = true;
            continue;
        }

        if (arg === '--require-provider-parameters') {
            options.requireParameters = true;
            continue;
        }

        options.extraArgs.push(arg);
    }

    return options;
}

function resolveDataset(datasetArg) {
    const candidate = path.isAbsolute(datasetArg)
        ? datasetArg
        : path.join(EVAL_DIR, 'datasets', datasetArg);

    if (fs.existsSync(candidate)) {
        return candidate;
    }

    if (fs.existsSync(path.join(EVAL_DIR, datasetArg))) {
        return path.join(EVAL_DIR, datasetArg);
    }

    throw new Error(`Dataset not found: ${datasetArg}`);
}

function listDatasets() {
    const datasetsDir = path.join(EVAL_DIR, 'datasets');
    return fs
        .readdirSync(datasetsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();
}

function listPresets() {
    return Object.entries(MODEL_PRESETS)
        .map(([name, config]) => ({
            name,
            provider: config.provider,
            model: config.model,
            apiKeyEnv: config.apiKeyEnv || defaultApiKeyEnv(config.provider),
            label: config.label,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function resolveDatasets(options) {
    if (options.all) {
        const entries = listDatasets();
        if (entries.length === 0) {
            throw new Error('No datasets found in evals/investigation/datasets');
        }
        return entries.map((entry) => path.join(EVAL_DIR, 'datasets', entry));
    }

    return [resolveDataset(options.dataset)];
}

function buildCombinedTestsFile(datasetPaths) {
    const combined = [];

    for (const datasetPath of datasetPaths) {
        const parsed = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
        if (!Array.isArray(parsed)) {
            throw new Error(
                `Dataset must be a JSON array of promptfoo tests: ${path.basename(datasetPath)}`,
            );
        }
        combined.push(...parsed);
    }

    fs.writeFileSync(TEMP_TESTS, JSON.stringify(combined, null, 2));
    return TEMP_TESTS;
}

function buildProviders(options) {
    if (
        options.presets.length > 0 &&
        (options.provider ||
            options.model ||
            options.label ||
            options.apiKeyEnv ||
            options.baseURL ||
            options.headers.length > 0 ||
            options.queryParams.length > 0 ||
            options.providerOrder.length > 0 ||
            options.allowFallbacks !== null ||
            options.requireParameters !== null)
    ) {
        throw new Error(
            'Use either --preset/--preset ... or custom --provider/--model overrides, not both.',
        );
    }

    if (options.presets.length > 0) {
        return options.presets.map(resolvePreset);
    }

    const hasCustomProviderConfig =
        options.provider ||
        options.model ||
        options.label ||
        options.apiKeyEnv ||
        options.baseURL ||
        options.headers.length > 0 ||
        options.queryParams.length > 0 ||
        options.providerOrder.length > 0 ||
        options.allowFallbacks !== null ||
        options.requireParameters !== null;

    if (!hasCustomProviderConfig) {
        return null;
    }

    if (!options.provider || !options.model) {
        throw new Error(
            'Custom provider runs require both --provider and --model.',
        );
    }

    return [
        normalizeProviderConfig({
            provider: options.provider,
            model: options.model,
            label: options.label,
            apiKeyEnv: options.apiKeyEnv || defaultApiKeyEnv(options.provider),
            baseURL: options.baseURL || defaultBaseUrl(options.provider),
            headers: parseKeyValueEntries(options.headers, '--header'),
            queryParams: parseKeyValueEntries(
                options.queryParams,
                '--query-param',
            ),
            providerOrder: options.providerOrder.filter(Boolean),
            allowFallbacks: options.allowFallbacks,
            requireParameters: options.requireParameters,
        }),
    ];
}

function buildConfig(testsPath, providers) {
    const config = yaml.load(fs.readFileSync(BASE_CONFIG, 'utf8'));
    const testsRef = pathToFileURL(testsPath).toString();

    if (!config || typeof config !== 'object') {
        throw new Error('Could not parse promptfoo.yaml');
    }

    config.tests = testsRef;

    if (providers && providers.length > 0) {
        config.providers = providers.map((providerConfig) => ({
            id: 'file://agent-provider.js',
            config: providerConfig,
        }));
    }

    return yaml.dump(config, {
        noRefs: true,
        lineWidth: -1,
    });
}

function clearRuntimeArtifacts() {
    for (const artifact of RUNTIME_ARTIFACTS) {
        try {
            fs.unlinkSync(artifact);
        } catch {}
    }
}

function printArtifactHints() {
    const existing = RUNTIME_ARTIFACTS.filter((artifact) => fs.existsSync(artifact));
    if (existing.length === 0) return;

    console.log('[eval:investigation] artifacts:');
    for (const artifact of existing) {
        console.log(`  - ${path.relative(process.cwd(), artifact)}`);
    }
}

function main() {
    const options = parseArgs(process.argv);
    if (options.listDatasets) {
        for (const entry of listDatasets()) {
            console.log(entry);
        }
        return;
    }

    if (options.listPresets) {
        for (const preset of listPresets()) {
            console.log(
                `${preset.name}\t${preset.provider}\t${preset.model}\t${preset.apiKeyEnv}\t${preset.label}`,
            );
        }
        return;
    }

    const datasetPaths = resolveDatasets(options);
    const testsPath = buildCombinedTestsFile(datasetPaths);
    const providers = buildProviders(options);

    clearRuntimeArtifacts();
    fs.writeFileSync(TEMP_CONFIG, buildConfig(testsPath, providers));

    const commandArgs = ['promptfoo', 'eval', '-c', TEMP_CONFIG];
    if (options.noCache) commandArgs.push('--no-cache');
    commandArgs.push(...options.extraArgs);

    console.log(
        `[eval:investigation] providers=${(
            providers && providers.length > 0
                ? providers
                : [{ label: 'base-config', provider: 'from-yaml', model: 'from-yaml' }]
        )
            .map((provider) => `${provider.label}(${provider.provider}:${provider.model})`)
            .join(',')} datasets=${datasetPaths
            .map((datasetPath) => path.basename(datasetPath))
            .join(',')} noCache=${options.noCache}`,
    );

    const npxInvocation = resolveNpxInvocation();
    const result = spawnSync(
        npxInvocation.command,
        [...npxInvocation.argsPrefix, ...commandArgs],
        {
        cwd: EVAL_DIR,
        stdio: 'inherit',
        env: process.env,
        },
    );

    if (result.error) {
        throw result.error;
    }

    printArtifactHints();
    process.exit(result.status || 0);
}

main();
