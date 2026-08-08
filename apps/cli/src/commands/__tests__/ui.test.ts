import { describe, it, expect } from 'vitest';
import { buildUiHtml } from '../trace/ui.js';

describe('trace ui SPA', () => {
    it('serves a self-contained SPA with session list and detail routes', () => {
        const html = buildUiHtml();
        expect(html).toContain('Kodus Trace');
        expect(html).toContain('/api/sessions');
        expect(html).toContain('No sessions yet');
        expect(html).toContain('renderDetail');
        expect(html).toContain('partial record');
        // No external network assets
        expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
        expect(html).not.toContain('cdn.');
    });
});
