import fs from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) =>
    fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('settings form sync source', () => {
    it('keeps custom prompt editors free from per-keystroke dirty callbacks', () => {
        const promptEditorFieldSource = read(
            'apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-prompts/_components/prompt-editor-field.tsx',
        );
        const customPromptsPageSource = read(
            'apps/web/src/app/(app)/settings/code-review/[repositoryId]/custom-prompts/page.tsx',
        );

        expect(promptEditorFieldSource).not.toContain('onDirtyChange');
        expect(promptEditorFieldSource).not.toContain('useEffect(');
        expect(customPromptsPageSource).not.toContain('setDirtyPromptFields');
        expect(customPromptsPageSource).toContain('dirtyFields');
    });

    it('uses a dedicated field component for ignore paths instead of hooks inside Controller render', () => {
        const ignorePathsSource = read(
            'apps/web/src/app/(app)/settings/code-review/[repositoryId]/general/_components/ignore-paths.tsx',
        );

        expect(ignorePathsSource).toContain('useController(');
        expect(ignorePathsSource).not.toContain('render={({ field }) =>');
    });
});
