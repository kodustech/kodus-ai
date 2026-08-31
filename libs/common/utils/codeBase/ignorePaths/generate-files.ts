import * as fs from 'fs';
import * as path from 'path';

import axios from 'axios';

// type for gitignore.io response
type GitignoreIoResponse = {
    [key: string]: {
        key: string;
        name: string;
        fileName: string;
        contents: string;
    };
};

// get all languages from gitignore.io
const getAllFromGitignoreIo = async (
    format: 'json' | 'lines' = 'json',
): Promise<GitignoreIoResponse> => {
    const url = 'https://www.gitignore.io/api/list?format=' + format;

    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error(error);
    }
};

// generate paths.json file from gitignore.io
const generateFiles = async (): Promise<void> => {
    try {
        // categories from gitiignore.io that are relevant
        const categories = [
            // generic
            'audio',
            'video',
            'images',
            'diskimage',
            'executable',
            'font',
            'fontforge',
            'games',
            'compression',
            'compressedarchive',
            'archive',
            'archives',
            'git',
            'database',
            'backup',

            // OS
            'windows',
            'linux',
            'macos',
            'osx',
            'android',

            // IDEs
            'androidstudio',
            'visualstudiocode',
            'visualstudio',
            'vim',
            'emacs',
            'jetbrains',
            'jetbrains+iml',
            'jetbrains+all',
            'goland',
            'goland+iml',
            'goland+all',
            'pycharm',
            'intellij',

            // languages
            'python',
            'java',
            'node',
            'yarn',
            'deno',
            'go',
            'ruby',
            'rust',
            'c',
            'csharp',
            'c++',
            'flutter',
            'lua',
            'dart',
            'zig',
            'swift',
            'ocaml',
            'haskell',
            'perl',
            'kotlin',
            'aspnetcore',
            'dotnetcore',

            // frameworks and tools
            'jupyternotebooks',
            'serverless',
            'rails',
            'flask',
            'django',
            'unity',
            'nextjs',
            'react',
            'svelte',
            'angular',
            'vue',
            'vuejs',
            'rust-analyzer',
            'clojure',
            'gradle',
            'maven',
            'meson',
            'ninja',
            'redis',
            'composer',
        ];

        // specific paths that are not covered by gitignore.io
        const toAdd = [
            '**/*.woff2',
            '**/*.eot',
            '**/*.hei[cf]',
            '**/*.exif',
            '**/*.mpeg',
            '**/*.m4[apv]',
            '**/*.3g[2p]',
            '**/*.dash',
            '**/*.f4v',
            '**/*.mts',
            '**/*.m2ts',
            '**/*.aac',
            '**/*.opus',
            '**/*.aiff',
            '**/*.caf',
            '**/*.dsd',
            '**/*.midi',
            '**/*.spx',
            '**/*.wv',
            '**/*.ape',
            '**/*.mka',
            '**/*.sfn',
            '**/*.bdf',
            '**/*.sqlite',
            '**/*.sql',
            '**/*.frm',
            '**/*.ibd',
            '**/*.fdb',
            '**/*.odb',
            '**/*.dmp',
            '**/*.sq3',
            '**/*.bin',
            '**/*.pkg',
            '**/temp',
            '**/tempfile',
            '**/cache',
            '**/*.temp',
            '**/*.old',
            '**/*.swo',
            '**/package.json',
            '**/environment',
            '**/Gemfile',
            '**/gemspec',
            '**/sln',
            '**/build.gradle',
            '**/gradle',
            '**/lock',
            '**/setup.py',
            '**/environment.yml',
            '**/terraform',
            '**/ansible',
            '**/bazel',
            '**/helm',
            '**/xcodeproj',
            '**/vscode',
            '**/xcworkspace',
            '**/docker-compose.yml',
            '**/terraform.tfstate',
            '**/terraform.tfvars',
            '**/lockfile',
            '**/version',
            '**/vendor/*',
            '**/go.sum',
            '**/go.mod',
            '**/requirements.txt',
            '**/package-lock.json',
            '**/*.min.*',
            '**/.idea/**',
            '**/*.lock',
            '**/*.pm',
            '**/*.xml',
            '**/.deno/**',
            '**/pyproject.toml',
            '**/Pipfile',
            '**/temp/**',
            '**/private/**',
            '**/public/**',
            '**/cache/**',
            '**/docs/**',
            '**/tests/**',
            '**/migrations/**',
            '**/assets/**',
            '**/uploads/**',
            '**/backup/**',
            '**/archive/**',
            '**/deploy/**',
            '**/staging/**',
            '**/prod/**',
            '**/bundler.js',
            '**/build.js',
        ];

        // specific paths that should be removed
        const toRemove = [
            '**/\\',
            '**/.\\',
            '**/*~',
            '**/._*',
            '**/~$*',
            '**/app/**/*.js',
            '**/*.js',
            '**/e2e/*.js',
            '**/lib/**',
            '**/lib64/**',
            '**/*.vb',
        ];

        const gitignores = await getAllFromGitignoreIo();

        const currentPath = path.resolve(__dirname);
        const outputPath = path.join(currentPath, 'generated');
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }

        const filePath = path.join(outputPath, 'paths.json');
        const paths = new Set<string>();

        for (const key of categories) {
            if (!(key in gitignores)) {
                continue;
            }

            const gitignore = gitignores[key];
            const content = gitignore.contents;
            const json = gitignoreToJson(content);

            if (!json) {
                continue;
            }

            json.paths.forEach((p: string) => {
                if (p.startsWith('/')) {
                    p = p.slice(1);
                }
                if (p.endsWith('/')) {
                    p += '**';
                }
                if (!p.startsWith('**/')) {
                    p = '**/' + p;
                }
                paths.add(p);
            });
        }

        toAdd.forEach((p) => paths.add(p));

        toRemove.forEach((p) => paths.delete(p));

        const json = JSON.stringify({ paths: Array.from(paths) }, null, 4);

        fs.writeFileSync(filePath, json, 'utf8');
    } catch (error) {
        console.error(error);
    }
};

// convert gitignore string to json
const gitignoreToJson = (
    gitignore: string,
): {
    paths: string[];
} | null => {
    // split by line
    const lines = gitignore.split('\n').map((line) => line.trim());

    // remove lines starting with # and inline comments
    const uncommented = lines
        .filter((line) => !line.startsWith('#') && line.trim() !== '')
        .map((line) => line.split('#')[0].trim());

    // remove lines starting with !
    const noBang = uncommented.filter((line) => !line.startsWith('!'));

    const json = {
        paths: noBang,
    };

    if (json.paths.length === 0) {
        return null;
    }

    return json;
};
