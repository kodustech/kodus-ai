// Default guidance for Code Review v2 categories and severity (string-only).
// These strings are newline-separated to render easily in textareas.

export const V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT = {
    bug: [
        '- Execution breaks: Code throws unhandled exceptions',
        "- Wrong results: Output doesn't match expected behavior",
        '- Resource leaks: Unclosed files, connections, memory accumulation',
        '- State corruption: Invalid object/data states',
        '- Logic errors: Control flow produces incorrect outcomes',
        '- Race conditions: Concurrent access causes inconsistent state or duplicates',
        "- Incorrect measurements: Metrics/timings that don't reflect actual operations",
        '- Invariant violations: Broken constraints (size limits, uniqueness, etc.)',
        '- Async timing bugs: Variables captured incorrectly in async closures',
        '- Conditional validation errors: Logic that checks for presence/absence of values using truthiness tests fails with falsy values (0, false, null, empty strings). The bug occurs when checking dictionary/map/object key existence or cached values that might be legitimately falsy. Examples: checking if a key exists by testing its value directly, validating cached boolean false as "not cached", treating numeric 0 as "missing value". Use explicit existence checks (hasOwnProperty, in operator, has() method, key?() method) or null-coalescing operators instead of relying on truthiness',
        '- Mutable default arguments: In languages with reference semantics for default parameters (Python, Ruby, JavaScript objects), mutable default values (arrays, dictionaries, objects) are evaluated ONCE at function definition, not per call. All invocations share the SAME instance, causing mutations to accumulate across calls. Example bug: a function with default empty array parameter where items are appended - second call starts with items from first call. Use null/None as default and initialize inside function body, or use factory patterns',
        '- Floating-point equality in critical operations: Direct equality comparisons on floating-point numbers in financial calculations, scientific computations, or accumulative operations are prone to fail due to IEEE 754 precision errors. Bug examples: comparing monetary totals after arithmetic, checking if balance is exactly zero after operations, comparing calculated prices. Use epsilon-based comparison (Math.abs(a - b) < threshold), dedicated decimal libraries (Decimal, BigDecimal, decimal.js), or integer arithmetic (cents instead of dollars). Note: simple assignments or literals may be acceptable',
        '- Closure capturing mutable references: Functions, lambdas, or closures that capture variables by reference (not by value) will see mutations made after closure creation. Bug occurs when creating multiple closures in a loop that all capture the same loop variable reference, or when captured configuration objects are mutated before closure execution. The closure executes with the final/mutated value, not the value at capture time. Use immediately-invoked functions, explicit value copying, or immutable captures to fix',
        '- Dead computation: Code that computes/transforms values but never uses the result, instead using the original untransformed value - indicates copy-paste error or incomplete refactoring',
        '- Unbounded growth: Collections (lists, dicts, sets) that grow indefinitely within loops without size limits, potentially causing memory exhaustion',
        '- Duplicate operations: Same operation executed multiple times with identical inputs in sequence, wasting resources and potentially causing incorrect counts/metrics',
    ].join('\n'),
    performance: [
        '- Algorithm complexity: O(n²) when O(n) is possible',
        '- Redundant operations: Duplicate calculations, unnecessary loops, or early returns that force multiple operations when a single operation would suffice (e.g., fail-fast in batch processing that requires multiple requests to get complete feedback)',
        '- Memory waste: Large allocations or leaks over time',
        '- Blocking operations: Synchronous I/O in critical paths',
        '- Database inefficiency: N+1, missing indexes, full scans',
        '- Cache misses: Not leveraging available caching mechanisms',
        '- Batch processing inefficiency: Validation or processing loops that return on first error instead of collecting all errors, forcing clients to make multiple requests to discover all issues',
    ].join('\n'),
    security: [
        '- Injection vulnerabilities: SQL/NoSQL/command/LDAP injection',
        '- AuthZ/AuthN flaws: Missing checks, privilege escalation',
        '- Data exposure: Sensitive data in logs, responses, or errors',
        '- Crypto issues: Weak algorithms, hardcoded keys, improper validation',
        '- Input validation gaps: Missing sanitization or bounds checks',
        '- Session management: Predictable tokens or missing expiration',
        '- Timing attacks: Direct string/value comparison of secrets, tokens, passwords, or authentication credentials that leaks information through execution time - must use constant-time comparison functions',
        '- Insecure fallback values: Using empty strings, default values, or weak fallbacks for critical security parameters (encryption keys, secrets, tokens) when environment variables are missing - system should fail-fast instead',
        '- Input validation bypass: User-controlled parameters (offsets, limits, indices, IDs) accepted without validation or with inadequate bounds checking, especially negative values in array slicing or pagination that could bypass access controls',
        '- SSRF (Server-Side Request Forgery): Using user-controlled URLs in network operations (open, fetch, HTTP requests) without allowlist validation, enabling access to internal resources or arbitrary external sites',
        "- Case-sensitivity bypass: Inconsistent normalization in comparisons of case-insensitive data (emails, usernames, domains) where one side is normalized (toLowerCase/toUpperCase) but the other isn't, allowing bypass through case variations",
    ].join('\n'),
};

export const V2_DEFAULT_SEVERITY_FLAGS_TEXT = {
    critical: [
        'Application crash/downtime',
        'Data loss/corruption',
        'Security breach (unauthorized access/data exfiltration)',
        'Critical operation failure (auth/payment/authorization)',
        'Direct financial loss operations',
        'Memory leaks that inevitably crash production',
    ].join('\n'),
    high: [
        'Important functionality broken',
        'Memory leaks that cause eventual crash',
        'Performance degradation affecting UX under normal load',
        'Security issues with indirect exploitation paths',
        'Financial calculation errors affecting revenue',
    ].join('\n'),
    medium: [
        'Partially broken functionality',
        'Performance issues in specific scenarios',
        'Security weaknesses requiring specific conditions',
        'Incorrect but recoverable data',
        'Non-critical business logic errors with workarounds',
    ].join('\n'),
    low: [
        'Minor performance overhead',
        'Low-risk security improvements',
        'Incorrect metrics/logs',
        'Rarely affecting few users',
        'Edge-case issues',
    ].join('\n'),
};

export const V2_DEFAULT_LEVEL_TEXT = {
    critical:
        'The code WILL crash, lose/corrupt data, or open a severe security breach in production. Immediate fix required before merge.',
    issue: 'The code produces WRONG results or fails to perform its intended function in at least one scenario, but does not cause catastrophic failure.',
    warning:
        'The code produces CORRECT results and performs its intended function in ALL scenarios but is suboptimal in style, performance, or maintainability.',
};

export function getV2DefaultsText() {
    return {
        categories: { ...V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT },
        severity: { ...V2_DEFAULT_SEVERITY_FLAGS_TEXT },
        level: { ...V2_DEFAULT_LEVEL_TEXT },
    };
}
