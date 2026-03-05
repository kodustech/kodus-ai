#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const datasetArg = process.argv.find((arg) => arg.startsWith('--dataset='));
const datasetPath = datasetArg
    ? path.resolve(process.cwd(), datasetArg.split('=')[1])
    : path.join(__dirname, 'datasets', 'memory-conversations-v2.json');

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number.parseInt(limitArg.split('=')[1], 10) : Infinity;

const outputFile = path.join(__dirname, 'datasets', 'memory-quality-tests.json');

function safeJsonParse(content, source) {
    try {
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Failed to parse JSON from ${source}: ${error.message}`);
    }
}

function readDataset(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Dataset not found: ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) {
        return [];
    }

    if (filePath.endsWith('.jsonl')) {
        return raw
            .split('\n')
            .filter(Boolean)
            .map((line, index) => safeJsonParse(line, `${filePath}:${index + 1}`));
    }

    const parsed = safeJsonParse(raw, filePath);

    if (Array.isArray(parsed)) {
        return parsed;
    }

    if (Array.isArray(parsed.examples)) {
        return parsed.examples;
    }

    throw new Error('Dataset JSON must be an array or an object with an "examples" array');
}

function normalizeMessages(input, id) {
    if (!input) {
        throw new Error(`${id}: input is required`);
    }

    const messages = Array.isArray(input) ? input : [input];
    if (messages.length !== 1) {
        throw new Error(`${id}: input must contain exactly one user message`);
    }

    const message = messages[0];
    const role = String(message?.role || 'user').toLowerCase();
    const content = String(message?.content || '').trim();

    if (role !== 'user') {
        throw new Error(`${id}: input role must be "user"`);
    }

    if (!content) {
        throw new Error(`${id}: input content cannot be empty`);
    }

    return {
        role: 'user',
        content,
    };
}

function normalizeContextSnippets(contextSnippets, id) {
    if (!Array.isArray(contextSnippets)) {
        throw new Error(`${id}: contextSnippets must be an array`);
    }

    if (contextSnippets.length !== 1) {
        throw new Error(`${id}: contextSnippets must contain exactly one snippet`);
    }

    const snippet = contextSnippets[0];
    const source = String(snippet?.source || '').trim();
    const code = String(snippet?.code || '').trim();

    if (!source) {
        throw new Error(`${id}: snippet source is required`);
    }

    if (!code) {
        throw new Error(`${id}: snippet code is required`);
    }

    return {
        id: snippet?.id || 'snippet-1',
        source,
        language: String(snippet?.language || 'text'),
        code,
    };
}

function buildPrepareContext(message, snippet, index) {
    const sourcePath = snippet.source;
    const sourceParts = sourcePath.split('/');
    const repositoryName = sourceParts[0] || 'kodus-ai';
    const pullRequestNumber = 1000 + index;

    return {
        gitUser: {
            id: 900000 + index,
            username: `dataset-user-${index}`,
        },
        userQuestion: message.content,
        repository: {
            id: `repo-${repositoryName}`,
            name: repositoryName,
            defaultBranch: 'main',
        },
        pullRequestDescription:
            'A pull request',
        platformType: 'github',
        pullRequest: {
            pullRequestNumber,
            headRef: `feature/foo-${index}`,
            baseRef: 'main',
        },
        codeManagementContext: {
            originalComment: {
                suggestionCommentId: `kody-suggestion-${index}`,
                suggestionFilePath: sourcePath,
                suggestionText:
                    `Consider adjusting this implementation.\n\n` +
                    snippet.code,
                diffHunk: snippet.code,
            },
            othersReplies: [],
        },
    };
}

function normalizeExpected(example) {
    const expected = example?.expected || {};

    return {
        triggerType:
            expected.triggerType === 'implicit' || expected.triggerType === 'explicit'
                ? expected.triggerType
                : '',
        rule: typeof expected.rule === 'string' ? expected.rule.trim() : '',
        reason: typeof expected.reason === 'string' ? expected.reason.trim() : '',
    };
}

function toBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const lowered = value.toLowerCase();
        if (lowered === 'true') return true;
        if (lowered === 'false') return false;
    }

    return false;
}

function buildTests(examples) {
    return examples.slice(0, limit).map((example, index) => {
        const id = example.id || `memory-quality-case-${index + 1}`;
        const message = normalizeMessages(example.input, id);
        const snippet = normalizeContextSnippets(example.contextSnippets, id);
        const expected = normalizeExpected(example);
        const shouldCreateMemory = toBoolean(example.shouldCreateMemory);
        const prepareContext = buildPrepareContext(message, snippet, index + 1);

        if (!shouldCreateMemory) {
            throw new Error(
                `${id}: this dataset is creation-only; shouldCreateMemory must be true`,
            );
        }

        if (!expected.rule) {
            throw new Error(
                `${id}: expected.rule is required for memory intent-quality evaluation`,
            );
        }

        return {
            description: `${id} (should-call)`,
            vars: {
                caseId: id,
                conversation: message.content,
                contextSnippets: JSON.stringify([snippet], null, 2),
                shouldCreateMemory: 'true',
                expectedTriggerType: expected.triggerType,
                expectedRule: expected.rule,
                expectedReason: expected.reason,
                expectedToolName: 'KODUS_CREATE_MEMORY',
                additionalInformation: JSON.stringify(prepareContext, null, 2),
                threadId: `mq-thread-${index + 1}`,
                sessionId: `mq-session-${index + 1}`,
                correlationId: `mq-correlation-${index + 1}`,
            },
            assert: [
                {
                    type: 'javascript',
                    value: 'file://memory-quality-llm-judge-assertion.js',
                },
            ],
        };
    });
}

const examples = readDataset(datasetPath);
const tests = buildTests(examples);

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} memory-quality examples to ${outputFile}`);
