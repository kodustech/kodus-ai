const { detectToolCalls } = require('./memory-parse-output');

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

function isNumberBetweenZeroAndOne(value) {
    return typeof value === 'number' && value >= 0 && value <= 1;
}

function hasNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function getFirstMatchingToolCall(toolCalls, expectedToolName) {
    const aliases = new Set([
        expectedToolName,
        'KODUS_CREATE_MEMORY',
    ]);

    return toolCalls.find((call) => aliases.has(call.name));
}

function parseExpectedList(raw) {
    if (!raw) {
        return [];
    }

    if (Array.isArray(raw)) {
        return raw.map(String);
    }

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.map(String);
            }
        } catch {
            return raw
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        }
    }

    return [];
}

function valueOrEmpty(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function validateStructuredPayload(toolCall) {
    const payload = toolCall?.input || {};
    const errors = [];

    const rule = payload.rule || payload.memory;
    if (!hasNonEmptyString(rule)) {
        errors.push('missing rule/memory text');
    }

    if (!isNumberBetweenZeroAndOne(payload.confidence)) {
        errors.push('missing or invalid confidence (0..1)');
    }

    const triggerType = payload.triggerType;
    if (triggerType !== 'explicit' && triggerType !== 'implicit') {
        errors.push('missing or invalid triggerType');
    }

    const scopeLevel = payload.scope?.level;
    if (!hasNonEmptyString(scopeLevel)) {
        errors.push('missing scope.level');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

function validateExpectedDimensions(payload, contextVars) {
    const checks = [];
    let weightedScore = 1;
    let totalWeight = 0;

    // Lower weight for triggerType mismatch
    const expectedTriggerType = valueOrEmpty(contextVars?.expectedTriggerType);
    if (expectedTriggerType) {
        const pass = payload?.triggerType === expectedTriggerType;
        checks.push({
            name: 'triggerType',
            expected: expectedTriggerType,
            actual: payload?.triggerType,
            pass,
            weight: 0.2,
        });
        weightedScore *= pass ? 1 : 0.8; // Only 20% penalty if wrong
        totalWeight += 0.2;
    }

    const expectedScopeLevel = valueOrEmpty(contextVars?.expectedScopeLevel);
    if (expectedScopeLevel) {
        const pass = payload?.scope?.level === expectedScopeLevel;
        checks.push({
            name: 'scopeLevel',
            expected: expectedScopeLevel,
            actual: payload?.scope?.level,
            pass,
            weight: 0.8,
        });
        weightedScore *= pass ? 1 : 0.0; // Full penalty if wrong
        totalWeight += 0.8;
    }

    // If no expectations, score is 1
    if (totalWeight === 0) weightedScore = 1;

    return {
        checks,
        score: weightedScore,
        hasExpectations: checks.length > 0,
    };
}

module.exports = (output, context) => {
    const shouldCreateMemory = toBoolean(context?.vars?.shouldCreateMemory);
    const expectedToolName =
        context?.vars?.expectedToolName || 'KODUS_CREATE_MEMORY';
    const toolCalls = detectToolCalls(output);
    const toolNames = toolCalls.map((call) => call.name);
    const matchingCall = getFirstMatchingToolCall(toolCalls, expectedToolName);
    const calledCreateMemory = Boolean(matchingCall);

    if (!shouldCreateMemory) {
        const pass = !calledCreateMemory;
        return {
            pass,
            score: pass ? 1 : 0,
            reason: pass
                ? 'MEMORY_NO_CALL_OK: no memory tool call detected'
                : `UNEXPECTED_MEMORY_CALL: detected ${toolNames.join(', ')}`,
        };
    }

    if (!calledCreateMemory) {
        return {
            pass: false,
            score: 0,
            reason: `MEMORY_CALL_MISSING: expected ${expectedToolName}`,
        };
    }

    const payloadValidation = validateStructuredPayload(matchingCall);
    const expectedValidation = validateExpectedDimensions(
        matchingCall?.input || {},
        context?.vars || {},
    );

    if (!payloadValidation.valid) {
        return {
            pass: false,
            score: 0.35,
            reason: `MEMORY_CALL_PARTIAL: ${payloadValidation.errors.join('; ')}`,
        };
    }

    const weightedScore = Number(
        (0.6 + 0.4 * expectedValidation.score).toFixed(4),
    );
    const pass = weightedScore >= 0.8;

    const dimensionSummary = expectedValidation.hasExpectations
        ? expectedValidation.checks
              .map((check) =>
                  `${check.name}=${check.pass ? 'ok' : 'fail'}`,
              )
              .join(', ')
        : 'no-dimension-expectations';

    return {
        pass,
        score: weightedScore,
        reason: `MEMORY_CALL_${pass ? 'OK' : 'PARTIAL'}: tool=${matchingCall.name}; structured=ok; dimensions=${dimensionSummary}; score=${weightedScore}`,
    };
};
