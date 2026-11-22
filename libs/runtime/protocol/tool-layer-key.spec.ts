import { readFileSync } from 'fs';
import { join } from 'path';

import { computeToolLayerKey, type ToolLayerKeyInput, ToolLayerKeyError } from './tool-layer-key';

// The Go cell runs the same file in key_parity_test.go: both sides must
// produce these keys byte for byte and refuse the same inputs.
const file = join(__dirname, 'tool-layer-key.json');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
    cases: { name: string; input: ToolLayerKeyInput; key: string }[];
    refused: { name: string; input: ToolLayerKeyInput; refusal: string }[];
};

describe('tool layer key parity with the Go cell', () => {
    it('is the same file the cell reads', () => {
        const copy = join(__dirname, '../../../apps/runtime-cell/internal/drivers/dockergvisor/toollayer/tool-layer-key.json');
        expect(readFileSync(copy, 'utf8')).toBe(readFileSync(file, 'utf8'));
    });

    it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        expect(computeToolLayerKey(c.input)).toBe(c.key);
    });

    it.each(fixture.refused.map((c) => [c.name, c] as const))('refuses: %s', (_name, c) => {
        expect.assertions(2);
        try {
            computeToolLayerKey(c.input);
        } catch (e) {
            expect(e).toBeInstanceOf(ToolLayerKeyError);
            expect((e as ToolLayerKeyError).code).toBe(c.refusal);
        }
    });

    it('has the cases that tell a naive encoder from Go (escapes and argument boundaries)', () => {
        const names = fixture.cases.map((c) => c.name);
        expect(names).toEqual(expect.arrayContaining(['html and separator characters in an argument', 'argument boundaries', 'argument boundaries, moved']));
        expect(new Set(fixture.cases.map((c) => c.key)).size).toBe(fixture.cases.length);
    });
});
