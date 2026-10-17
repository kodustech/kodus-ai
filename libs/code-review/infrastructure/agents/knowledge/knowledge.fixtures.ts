import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';

import type {
    BaseBranchReader,
    BaseBranchReadResult,
} from './base-branch-reader';
import { normalizeRepoPath } from './knowledge-path';

/** Target-branch files of an invented ledger service, for knowledge specs. */
export class InMemoryBaseBranchReader implements BaseBranchReader {
    readonly ref = 'main';
    readonly reads: string[] = [];

    constructor(
        private readonly files: Record<string, string>,
        private readonly symlinks: string[] = [],
    ) {}

    async readFile(path: string): Promise<BaseBranchReadResult> {
        const normalized = normalizeRepoPath(path);
        if (!normalized) return { status: 'refused', reason: 'invalid path' };
        this.reads.push(normalized);
        if (this.symlinks.includes(normalized)) {
            return { status: 'refused', reason: 'symbolic links are not read' };
        }
        const content = this.files[normalized];
        return content === undefined
            ? { status: 'missing' }
            : { status: 'ok', content };
    }

    async listFiles(dir: string): Promise<string[]> {
        return Object.keys(this.files).filter((f) => f.startsWith(`${dir}/`));
    }

    async matchFiles(glob: string): Promise<string[]> {
        return Object.keys(this.files).filter((f) =>
            isFileMatchingGlob(f, [glob]),
        );
    }
}

export const skillMarkdown = (
    name: string,
    description: string,
    body = '## Errors\n\nRaise LedgerError with a code from references/codes.md.',
    extra = '',
) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;
