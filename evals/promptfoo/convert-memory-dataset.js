#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const datasetArg = process.argv.find((a) => a.startsWith('--dataset='));
const datasetPath = datasetArg
    ? path.resolve(process.cwd(), datasetArg.split('=')[1])
    : path.join(__dirname, 'datasets', 'memory-conversations.json');

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const outputFile = path.join(__dirname, 'datasets', 'memory-tests.json');

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

function normalizeConversation(example) {
    const conversation =
        example.conversation ||
        example.messages ||
        example.input?.conversation ||
        example.input?.messages ||
        example.input ||
        example.userInput ||
        example.prompt;
    if (!conversation) {
        return [];
    }

    if (typeof conversation === 'string') {
        return [{ role: 'user', content: conversation }];
    }

    if (typeof conversation === 'object' && !Array.isArray(conversation)) {
        if (conversation.role || conversation.content) {
            return [
                {
                    role: conversation.role || 'user',
                    content: String(conversation.content || ''),
                },
            ];
        }
    }

    if (!Array.isArray(conversation)) {
        return [];
    }

    return conversation.map((message) => ({
        role: message.role || 'user',
        content: String(message.content || ''),
    }));
}

function normalizeExpected(example) {
    const explicit = example.shouldCreateMemory;
    const nested = example.expected?.shouldCreateMemory;
    const raw = explicit !== undefined ? explicit : nested;

    if (typeof raw === 'boolean') {
        return raw;
    }

    if (typeof raw === 'string') {
        const lowered = raw.toLowerCase();
        if (lowered === 'true') return true;
        if (lowered === 'false') return false;
    }

    return false;
}

function normalizeStringField(example, fieldName, fallback = '') {
    const direct = example[fieldName];
    const nestedInput = example.input?.[fieldName];
    const nestedMeta = example.metadata?.[fieldName];
    const value = direct ?? nestedInput ?? nestedMeta;

    if (value === undefined || value === null) {
        return fallback;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'object') {
        return JSON.stringify(value);
    }

    return String(value);
}

function normalizeExpectedToolName(example) {
    const direct = example.expectedToolName;
    const nested = example.expected?.toolName;
    const value = direct ?? nested;

    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }

    return 'KODUS_CREATE_MEMORY';
}

function normalizeExpectedValue(example, key, fallback = '') {
    const nestedExpected = example.expected?.[key];
    const topLevel = example[`expected${key.charAt(0).toUpperCase()}${key.slice(1)}`];
    const value = nestedExpected ?? topLevel;

    if (value === undefined || value === null) {
        return fallback;
    }

    if (Array.isArray(value) || typeof value === 'object') {
        return JSON.stringify(value);
    }

    return String(value);
}

function buildTests(examples) {
    return examples.slice(0, limit).map((example, index) => {
        const conversation = normalizeConversation(example);
        const shouldCreateMemory = normalizeExpected(example);
        const id = example.id || example.caseId || `memory-case-${index + 1}`;
        const additionalInformation = normalizeStringField(
            example,
            'additionalInformation',
        );
        const threadId = normalizeStringField(
            example,
            'threadId',
            `memory-thread-${index + 1}`,
        );
        const sessionId = normalizeStringField(
            example,
            'sessionId',
            `memory-session-${index + 1}`,
        );
        const correlationId = normalizeStringField(
            example,
            'correlationId',
            `memory-correlation-${index + 1}`,
        );
        const expectedToolName = normalizeExpectedToolName(example);
        const expectedTriggerType = normalizeExpectedValue(
            example,
            'triggerType',
        );
        const expectedScopeLevel = normalizeExpectedValue(
            example,
            'scopeLevel',
        );
        const expectedApplyDuring = normalizeExpectedValue(
            example,
            'applyDuring',
        );
        const expectedApprovalMode = normalizeExpectedValue(
            example,
            'approvalMode',
        );
        const expectedLifecycleAction = normalizeExpectedValue(
            example,
            'lifecycleAction',
        );
        const expectedRule = normalizeExpectedValue(example, 'rule');
        const expectedAmbiguityLevel = normalizeExpectedValue(
            example,
            'ambiguityLevel',
        );

        return {
            description: `${id} (${shouldCreateMemory ? 'should-call' : 'should-not-call'})`,
            vars: {
                conversation: JSON.stringify(conversation, null, 2),
                shouldCreateMemory: String(shouldCreateMemory),
                expectedToolName,
                expectedTriggerType,
                expectedScopeLevel,
                expectedApplyDuring,
                expectedApprovalMode,
                expectedLifecycleAction,
                expectedRule,
                expectedAmbiguityLevel,
                additionalInformation,
                threadId,
                sessionId,
                correlationId,
            },
            assert: [
                {
                    type: 'javascript',
                    value: 'file://memory-tool-call-assertion.js',
                },
                {
                    type: 'javascript',
                    value: 'file://memory-llm-judge-assertion.js',
                },
            ],
        };
    });
}

const examples = readDataset(datasetPath);
const tests = buildTests(examples);

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} memory examples to ${outputFile}`);
