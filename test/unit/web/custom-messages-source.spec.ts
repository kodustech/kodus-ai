import fs from 'node:fs';
import path from 'node:path';

describe('custom messages source', () => {
    it('keeps a single editor state instead of parallel draft stores', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-messages/page.tsx',
            ),
            'utf8',
        );

        expect(source).toContain('const [editorState, setEditorState]');
        expect(source).not.toContain('const [messages, setMessages]');
        expect(source).not.toContain(
            'const [globalSettings, setGlobalSettings]',
        );
    });
});
