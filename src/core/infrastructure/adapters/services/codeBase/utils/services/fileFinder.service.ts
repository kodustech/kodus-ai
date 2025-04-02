import { glob } from 'glob';
import path from 'path';

export class FileFinderService {
    private readonly supportedExtensions = {
        csharp: ['cs', 'csx', 'cshtml'],
        javascript: ['js', 'jsx', 'ts', 'tsx'],
        ruby: ['rb', 'rake', 'gemspec'],
        php: ['php', 'phtml', 'php5'],
        python: ['py', 'pyw'],
    };

    private readonly ignoredDirs = [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/bin/**',
        '**/obj/**',
        '**/.git/**',
        '**/vendor/**',
        '**/__pycache__/**',
    ];

    async findProjectFiles(repoPath: string): Promise<string[]> {
        const allExtensions = Object.values(this.supportedExtensions)
            .flat()
            .map((ext) => `**/*.${ext}`);

        try {
            const files = await glob(allExtensions, {
                cwd: repoPath,
                absolute: true,
                ignore: this.ignoredDirs,
                nodir: true,
            });

            return files;
        } catch (error) {
            console.error('Error finding files:', error);
            return [];
        }
    }
}
