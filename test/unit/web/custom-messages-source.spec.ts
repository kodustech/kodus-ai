import fs from 'node:fs';
import path from 'node:path';

describe('custom messages source', () => {
    it('keeps a single editor state instead of parallel draft stores', () => {
        // The state moved out of the page and into the editor hook the page
        // and its tabs share; the invariant is still "one draft store".
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-messages/_components/custom-messages-editor.tsx',
            ),
            'utf8',
        );

        expect(source).toContain('const [editorState, setEditorState]');
        expect(source).not.toContain('const [messages, setMessages]');
        expect(source).not.toContain(
            'const [globalSettings, setGlobalSettings]',
        );
    });

    it('does not keep a second copy of the draft in the page', () => {
        const source = fs.readFileSync(
            path.join(
                process.cwd(),
                'apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-messages/page.tsx',
            ),
            'utf8',
        );

        expect(source).toContain('useCustomMessagesEditor()');
        expect(source).not.toContain('const [editorState, setEditorState]');
    });
});
