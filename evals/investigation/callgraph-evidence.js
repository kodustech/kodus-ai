function decodeXml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function xmlAttributes(source) {
    const attributes = {};
    const matcher = /([\w-]+)="([^"]*)"/g;
    let match;
    while ((match = matcher.exec(source))) {
        attributes[match[1]] = decodeXml(match[2]);
    }
    return attributes;
}

function isTestFile(file) {
    return /(?:^|\/)(?:__tests__|test|tests|spec)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(
        file,
    );
}

function numberAttribute(attributes, name) {
    const value = Number(attributes[name]);
    return Number.isFinite(value) ? value : undefined;
}

function relations(body, tag, includesLine) {
    const items = [];
    const matcher = new RegExp(`<${tag}\\b([^>]*)\\/?\\s*>`, 'g');
    let match;
    while ((match = matcher.exec(body))) {
        const attributes = xmlAttributes(match[1]);
        if (!attributes.name || !attributes.file) {
            continue;
        }

        const relation = {
            name: attributes.name,
            file: attributes.file,
        };
        if (includesLine) {
            const line = numberAttribute(attributes, 'line');
            if (line !== undefined) {
                relation.line = line;
            }
        }
        const confidence = numberAttribute(attributes, 'confidence');
        if (confidence !== undefined) {
            relation.confidence = confidence;
        }
        if (includesLine) {
            relation.isTest = isTestFile(attributes.file);
        }
        items.push(relation);
    }
    return items;
}

function auditCallGraphEvidence(xml) {
    if (typeof xml !== 'string' || !xml.includes('<CallGraph>')) {
        return {
            available: false,
            changedFunctions: [],
            orderingViolations: [],
        };
    }

    const changedFunctions = [];
    const matcher = /<ChangedFunction\b([^>]*)>([\s\S]*?)<\/ChangedFunction>/g;
    let match;
    while ((match = matcher.exec(xml))) {
        const attributes = xmlAttributes(match[1]);
        if (!attributes.name || !attributes.file) {
            continue;
        }
        changedFunctions.push({
            name: attributes.name,
            file: attributes.file,
            callers: relations(match[2], 'Caller', true),
            callees: relations(match[2], 'Callee', false),
        });
    }

    const orderingViolations = [];
    for (const changedFunction of changedFunctions) {
        const testIndex = changedFunction.callers.findIndex(
            (caller) => caller.isTest,
        );
        const productionIndex = changedFunction.callers.findIndex(
            (caller, index) => index > testIndex && !caller.isTest,
        );
        if (testIndex < 0 || productionIndex < 0) {
            continue;
        }
        orderingViolations.push({
            changedFunction: {
                name: changedFunction.name,
                file: changedFunction.file,
            },
            firstTestCaller: pickIdentity(changedFunction.callers[testIndex]),
            firstProductionCaller: pickIdentity(
                changedFunction.callers[productionIndex],
            ),
        });
    }

    return {
        available: true,
        changedFunctions,
        orderingViolations,
    };
}

function pickIdentity(relation) {
    return {
        name: relation.name,
        file: relation.file,
    };
}

function sameIdentity(left, right) {
    return left.name === right.name && left.file === right.file;
}

function validateRequirement(requirement) {
    if (!requirement || typeof requirement !== 'object') {
        throw new Error('call graph expectation requirement must be an object');
    }
    if (
        requirement.relation !== 'caller' &&
        requirement.relation !== 'callee'
    ) {
        throw new Error(
            'call graph expectation relation must be caller or callee',
        );
    }
    for (const field of ['source', 'target']) {
        const value = requirement[field];
        if (
            !value ||
            typeof value.name !== 'string' ||
            typeof value.file !== 'string'
        ) {
            throw new Error(
                `call graph expectation ${field} must include name and file`,
            );
        }
    }
}

function requiredRelations(manifest, caseId) {
    validateManifest(manifest);
    const caseExpectation = manifest.cases[caseId];
    return caseExpectation ? caseExpectation.required : [];
}

function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('call graph expectation manifest must be an object');
    }
    if (
        !manifest.cases ||
        typeof manifest.cases !== 'object' ||
        Array.isArray(manifest.cases)
    ) {
        throw new Error(
            'call graph expectation manifest cases must be an object',
        );
    }
    for (const [caseId, caseExpectation] of Object.entries(manifest.cases)) {
        if (!caseExpectation || !Array.isArray(caseExpectation.required)) {
            throw new Error(
                `call graph expectation case ${caseId} required must be an array`,
            );
        }
        for (const requirement of caseExpectation.required) {
            validateRequirement(requirement);
        }
    }
}

function evaluateCallGraphExpectations(xml, manifest, caseId) {
    const audit = auditCallGraphEvidence(xml);
    const required = requiredRelations(manifest, caseId);
    const missing = [];
    let matched = 0;

    for (const requirement of required) {
        const source = audit.changedFunctions.find((changedFunction) =>
            sameIdentity(changedFunction, requirement.source),
        );
        const relation = source?.[`${requirement.relation}s`]?.find((item) =>
            sameIdentity(item, requirement.target),
        );
        if (relation) {
            matched += 1;
        } else {
            missing.push(requirement);
        }
    }

    return {
        available: audit.available,
        required: required.length,
        matched,
        missing,
        orderingViolations: audit.orderingViolations,
    };
}

function auditCallGraphCases(tests, manifest) {
    validateManifest(manifest);
    const rows = tests
        .map((test) => {
            const vars = test?.vars || {};
            const caseId = vars.caseId || test.description || 'unknown-case';
            if (!Object.hasOwn(manifest.cases, caseId)) {
                return null;
            }
            return {
                caseId,
                ...evaluateCallGraphExpectations(
                    vars.callGraph,
                    manifest,
                    caseId,
                ),
            };
        })
        .filter(Boolean);

    return {
        cases: rows.length,
        availableCases: rows.filter((row) => row.available).length,
        unavailableCases: rows.filter((row) => !row.available).length,
        required: rows.reduce((sum, row) => sum + row.required, 0),
        matched: rows.reduce((sum, row) => sum + row.matched, 0),
        missing: rows.reduce((sum, row) => sum + row.missing.length, 0),
        orderingViolations: rows.reduce(
            (sum, row) => sum + row.orderingViolations.length,
            0,
        ),
        rows,
    };
}

module.exports = {
    auditCallGraphEvidence,
    auditCallGraphCases,
    evaluateCallGraphExpectations,
};
