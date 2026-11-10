import { readFileSync } from 'fs';
import { join } from 'path';

import { REDACTION_RULES, REDACTION_RULES_SOURCE, redactPatterns } from './redaction';

describe('S-51 token-pattern redaction (shared with the cell)', () => {
    it('is the same rule file the Go cell embeds, with the gitleaks commit and MIT notice', () => {
        const ts = readFileSync(join(__dirname, 'gitleaks-rules.json'));
        const go = readFileSync(join(__dirname, '../../../apps/runtime-cell/internal/redact/rules/gitleaks-rules.json'));
        expect(go.equals(ts)).toBe(true);
        expect(REDACTION_RULES_SOURCE).toMatchObject({ license: 'MIT', url: expect.stringContaining(REDACTION_RULES_SOURCE.commit) });
        expect(REDACTION_RULES_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(JSON.parse(ts.toString()).license).toContain('Zachary Rice');
    });

    it.each(REDACTION_RULES.flatMap((r) => r.examples.map((ex) => [r.id, ex] as const)))('%s redacts its example', (id, ex) => {
        const out = redactPatterns(ex);
        expect(out.count).toBeGreaterThan(0);
        expect(out.text).toContain(`[redacted:${id}]`);
    });

    it('keeps the context around a secret group and counts by rule', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const out = redactPatterns(`AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAuthorization: Bearer abcdefgh12345678\nsession ${jwt} ok`);
        expect(out.text).toBe('AWS_ACCESS_KEY_ID=[redacted:aws-access-token]\nAuthorization: Bearer [redacted:generic-bearer]\nsession [redacted:jwt] ok');
        expect(out.byRule).toEqual({ 'aws-access-token': 1, 'generic-bearer': 1, jwt: 1 });
        expect(out.count).toBe(3);
    });

    it('leaves ordinary output alone', () => {
        for (const s of ['GET /orders/42 200 12ms', 'token refreshed successfully for user 42', 'key: value_that_is_long_enough', 'Bearer']) {
            expect(redactPatterns(s)).toEqual({ text: s, count: 0, byRule: {} });
        }
    });
});

describe('presigned URL credentials', () => {
    it("redacts an S3 presigned URL's session token, signature and credential, keeping the URL readable", () => {
        const url =
            'failed open: https://docker-images-prod.s3.dualstack.us-east-1.amazonaws.com/registry-v2/blobs/sha256/c1/data?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIA2EXAMPLEEXAMPLE7%2F20261105%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261105T121733Z&X-Amz-Expires=1200&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEPz%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIDnQh%2F2iy5x2fduQ&X-Amz-SignedHeaders=host&X-Amz-Signature=e6037c84f630c389ed1ed99861615ebe903157acccdb4acc2256195625994829": dial tcp';
        const { text } = redactPatterns(url);
        expect(text).not.toContain('IQoJb3JpZ2luX2VjEPz');
        expect(text).not.toContain('e6037c84f630c389');
        expect(text).not.toContain('ASIA2EXAMPLEEXAMPLE7');
        expect(text).toContain('docker-images-prod.s3.dualstack.us-east-1.amazonaws.com');
        expect(text).toContain('X-Amz-Expires=1200');
    });
});
