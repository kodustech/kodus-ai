/**
 * Mutation-killing spec for the deterministic parsing/normalization logic in
 * DocumentationPackageDiscoveryService.
 *
 * The service's constructor only stores an injected pull-request manager that
 * NONE of the deterministic methods under test touch, so we build the instance
 * with an inert `{} as any` stub and reach the private methods through casts.
 * Every assertion pins exact return values (deep equality, exact order/membership,
 * specific literals and boundaries) so a plausible regression fails the test.
 */

import { DocumentationPackageDiscoveryService } from './documentation-package-discovery.service';

// The exact root manifest set the source declares. Redefined here purely as the
// expected value for assertions (not to shadow the source constant).
const ROOT_MANIFEST_FILES = [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'go.mod',
    'Cargo.toml',
    'Gemfile',
];

describe('DocumentationPackageDiscoveryService deterministic logic', () => {
    let service: DocumentationPackageDiscoveryService;
    const call = (method: string, ...args: any[]) =>
        (service as any)[method](...args);

    beforeEach(() => {
        service = new DocumentationPackageDiscoveryService({} as any);
    });

    describe('isSupportedManifestFile', () => {
        it('returns true when the basename is a supported manifest (nested path)', () => {
            expect(call('isSupportedManifestFile', 'a/b/package.json')).toBe(
                true,
            );
        });

        it('recognizes every supported manifest by basename', () => {
            for (const name of ROOT_MANIFEST_FILES) {
                expect(
                    call('isSupportedManifestFile', `deep/dir/${name}`),
                ).toBe(true);
            }
        });

        it('returns false for an unsupported basename', () => {
            expect(call('isSupportedManifestFile', 'src/index.ts')).toBe(false);
        });

        it('matches on basename only, not on substring of the path', () => {
            // "package.json" appears as a directory segment, not the basename.
            expect(
                call('isSupportedManifestFile', 'package.json/notes.md'),
            ).toBe(false);
        });
    });

    describe('extractPathsFromRipgrepOutput', () => {
        it('extracts paths, strips leading ./, and dedupes preserving first-seen order', () => {
            const output = [
                './a/package.json:1:{',
                './a/package.json:2:  "name"',
                './b/go.mod:5:module x',
            ].join('\n');

            expect(call('extractPathsFromRipgrepOutput', output)).toEqual([
                'a/package.json',
                'b/go.mod',
            ]);
        });

        it('skips blank lines and lines without the :<line-number>: shape', () => {
            const output = [
                '',
                '   ',
                'no-line-number-here',
                'plain:notdigits:x',
                './c/Gemfile:9:gem "rails"',
            ].join('\n');

            expect(call('extractPathsFromRipgrepOutput', output)).toEqual([
                'c/Gemfile',
            ]);
        });

        it('drops a match whose path normalizes to empty (guard on normalizedPath)', () => {
            // "./" -> after stripping leading "./" becomes "" and is skipped.
            expect(call('extractPathsFromRipgrepOutput', './:1:x')).toEqual([]);
        });

        it('returns [] for empty/nullish output', () => {
            expect(call('extractPathsFromRipgrepOutput', '')).toEqual([]);
            expect(call('extractPathsFromRipgrepOutput', undefined)).toEqual(
                [],
            );
        });
    });

    describe('normalizeDirectory', () => {
        it('maps empty-like directories to empty string', () => {
            expect(call('normalizeDirectory', '')).toBe('');
            expect(call('normalizeDirectory', '.')).toBe('');
            expect(call('normalizeDirectory', '/')).toBe('');
        });

        it('strips leading and trailing slashes only', () => {
            expect(call('normalizeDirectory', '/foo/bar/')).toBe('foo/bar');
            expect(call('normalizeDirectory', '//foo//')).toBe('foo');
        });

        it('leaves an already-clean nested directory untouched', () => {
            expect(call('normalizeDirectory', 'foo/bar')).toBe('foo/bar');
        });
    });

    describe('buildManifestCandidatesForFile', () => {
        it('returns exactly the root manifests for a file at repo root', () => {
            expect(
                call('buildManifestCandidatesForFile', 'package.json'),
            ).toEqual(ROOT_MANIFEST_FILES);
        });

        it('walks every ancestor directory up to the root', () => {
            const result: string[] = call(
                'buildManifestCandidatesForFile',
                'a/b/foo.ts',
            );

            const expected = [
                ...ROOT_MANIFEST_FILES.map((m) => `a/b/${m}`),
                ...ROOT_MANIFEST_FILES.map((m) => `a/${m}`),
                ...ROOT_MANIFEST_FILES,
            ];

            expect(result).toEqual(expected);
            // 3 directory levels (a/b, a, root) * 9 manifests, all unique.
            expect(result).toHaveLength(27);
        });
    });

    describe('normalizeVersion', () => {
        it('returns undefined for undefined/empty input (falsy guard)', () => {
            expect(call('normalizeVersion', undefined)).toBeUndefined();
            expect(call('normalizeVersion', '')).toBeUndefined();
        });

        it('returns undefined when the value is only whitespace (length boundary)', () => {
            expect(call('normalizeVersion', '   ')).toBeUndefined();
        });

        it('trims and returns a non-empty version', () => {
            expect(call('normalizeVersion', '  1.2.3  ')).toBe('1.2.3');
        });

        it('preserves a single non-space character (length > 0 boundary)', () => {
            expect(call('normalizeVersion', '0')).toBe('0');
        });
    });

    describe('parsePythonRequirementSpec', () => {
        it('parses name and version from a pinned spec', () => {
            expect(
                call(
                    'parsePythonRequirementSpec',
                    'requests==2.0.1',
                    'req.toml',
                ),
            ).toEqual({
                name: 'requests',
                version: '2.0.1',
                ecosystem: 'pip',
                sourceFile: 'req.toml',
            });
        });

        it('returns a name with undefined version when there is no specifier', () => {
            expect(
                call('parsePythonRequirementSpec', 'django', 'req.toml'),
            ).toEqual({
                name: 'django',
                version: undefined,
                ecosystem: 'pip',
                sourceFile: 'req.toml',
            });
        });

        it('stops the version at a semicolon/whitespace marker', () => {
            expect(
                call(
                    'parsePythonRequirementSpec',
                    'foo>=1.0; python_version<"3"',
                    'req.toml',
                ),
            ).toEqual({
                name: 'foo',
                version: '1.0',
                ecosystem: 'pip',
                sourceFile: 'req.toml',
            });
        });

        it('returns null for a blank/whitespace-only spec', () => {
            expect(
                call('parsePythonRequirementSpec', '   ', 'req.toml'),
            ).toBeNull();
        });

        it('returns null when nothing matches the name pattern', () => {
            expect(
                call('parsePythonRequirementSpec', '===', 'req.toml'),
            ).toBeNull();
        });
    });

    describe('parsePackageJson', () => {
        it('collects deps from all four sections in order with npm ecosystem', () => {
            const content = JSON.stringify({
                dependencies: { react: '^18.0.0' },
                devDependencies: { jest: '29.0.0' },
                peerDependencies: { 'react-dom': '^18.0.0' },
                optionalDependencies: { fsevents: '2.3.2' },
            });

            expect(call('parsePackageJson', 'package.json', content)).toEqual([
                {
                    name: 'react',
                    version: '^18.0.0',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
                {
                    name: 'jest',
                    version: '29.0.0',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
                {
                    name: 'react-dom',
                    version: '^18.0.0',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
                {
                    name: 'fsevents',
                    version: '2.3.2',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ]);
        });

        it('normalizes an empty-string version to undefined', () => {
            const content = JSON.stringify({ dependencies: { foo: '' } });
            expect(call('parsePackageJson', 'package.json', content)).toEqual([
                {
                    name: 'foo',
                    version: undefined,
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ]);
        });

        it('skips a section that is present but not an object', () => {
            const content = JSON.stringify({
                dependencies: 'not-an-object',
                devDependencies: { real: '1.0.0' },
            });
            expect(call('parsePackageJson', 'package.json', content)).toEqual([
                {
                    name: 'real',
                    version: '1.0.0',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ]);
        });

        it('returns [] on invalid JSON (catch fallback)', () => {
            expect(
                call('parsePackageJson', 'package.json', '{ not json'),
            ).toEqual([]);
        });
    });

    describe('parseRequirementsTxt', () => {
        it('parses pinned and unpinned requirements, skipping comments and options', () => {
            const content = [
                '# a comment',
                '-r other.txt',
                'flask==2.0.1',
                'requests',
                '',
            ].join('\n');

            expect(
                call('parseRequirementsTxt', 'requirements.txt', content),
            ).toEqual([
                {
                    name: 'flask',
                    version: '2.0.1',
                    ecosystem: 'pip',
                    sourceFile: 'requirements.txt',
                },
                {
                    name: 'requests',
                    version: undefined,
                    ecosystem: 'pip',
                    sourceFile: 'requirements.txt',
                },
            ]);
        });

        it('returns [] when there is nothing parseable', () => {
            expect(
                call(
                    'parseRequirementsTxt',
                    'requirements.txt',
                    '# only comment',
                ),
            ).toEqual([]);
        });
    });

    describe('parsePyprojectToml', () => {
        it('parses PEP 621 project.dependencies (array)', () => {
            const content = [
                '[project]',
                'dependencies = ["requests>=2.0", "flask"]',
            ].join('\n');

            expect(
                call('parsePyprojectToml', 'pyproject.toml', content),
            ).toEqual([
                {
                    name: 'requests',
                    version: '2.0',
                    ecosystem: 'pip',
                    sourceFile: 'pyproject.toml',
                },
                {
                    name: 'flask',
                    version: undefined,
                    ecosystem: 'pip',
                    sourceFile: 'pyproject.toml',
                },
            ]);
        });

        it('parses PEP 621 optional-dependencies groups', () => {
            const content = [
                '[project.optional-dependencies]',
                'dev = ["pytest==7.0"]',
            ].join('\n');

            expect(
                call('parsePyprojectToml', 'pyproject.toml', content),
            ).toEqual([
                {
                    name: 'pytest',
                    version: '7.0',
                    ecosystem: 'pip',
                    sourceFile: 'pyproject.toml',
                },
            ]);
        });

        it('parses poetry dependencies (string and table), skipping python', () => {
            const content = [
                '[tool.poetry.dependencies]',
                'python = "^3.9"',
                'requests = "^2.28"',
                'flask = { version = "2.0", optional = true }',
            ].join('\n');

            expect(
                call('parsePyprojectToml', 'pyproject.toml', content),
            ).toEqual([
                {
                    name: 'requests',
                    version: '^2.28',
                    ecosystem: 'pip',
                    sourceFile: 'pyproject.toml',
                },
                {
                    name: 'flask',
                    version: '2.0',
                    ecosystem: 'pip',
                    sourceFile: 'pyproject.toml',
                },
            ]);
        });

        it('returns [] on invalid TOML (catch fallback)', () => {
            expect(
                call(
                    'parsePyprojectToml',
                    'pyproject.toml',
                    'this = = invalid',
                ),
            ).toEqual([]);
        });
    });

    describe('parsePomXml', () => {
        it('wraps a single dependency into one maven reference', () => {
            const content =
                '<project><dependencies><dependency>' +
                '<groupId>org.example</groupId>' +
                '<artifactId>lib</artifactId>' +
                '<version>4.13.2</version>' +
                '</dependency></dependencies></project>';

            expect(call('parsePomXml', 'pom.xml', content)).toEqual([
                {
                    name: 'org.example:lib',
                    version: '4.13.2',
                    ecosystem: 'maven',
                    sourceFile: 'pom.xml',
                },
            ]);
        });

        it('handles multiple dependencies as an array', () => {
            const content =
                '<project><dependencies>' +
                '<dependency><groupId>g.one</groupId><artifactId>a.one</artifactId><version>1.2.3</version></dependency>' +
                '<dependency><groupId>g.two</groupId><artifactId>a.two</artifactId><version>4.5.6</version></dependency>' +
                '</dependencies></project>';

            expect(call('parsePomXml', 'pom.xml', content)).toEqual([
                {
                    name: 'g.one:a.one',
                    version: '1.2.3',
                    ecosystem: 'maven',
                    sourceFile: 'pom.xml',
                },
                {
                    name: 'g.two:a.two',
                    version: '4.5.6',
                    ecosystem: 'maven',
                    sourceFile: 'pom.xml',
                },
            ]);
        });

        it('returns [] when there are no dependencies', () => {
            expect(
                call('parsePomXml', 'pom.xml', '<project></project>'),
            ).toEqual([]);
        });
    });

    describe('parseGradle', () => {
        it('extracts group:artifact:version for supported configurations', () => {
            const content = [
                "implementation 'com.google.guava:guava:31.0'",
                'api("org.foo:bar:1.2.3")',
                "testImplementation 'junit:junit:4.13.2'",
            ].join('\n');

            expect(call('parseGradle', 'build.gradle', content)).toEqual([
                {
                    name: 'com.google.guava:guava',
                    version: '31.0',
                    ecosystem: 'gradle',
                    sourceFile: 'build.gradle',
                },
                {
                    name: 'org.foo:bar',
                    version: '1.2.3',
                    ecosystem: 'gradle',
                    sourceFile: 'build.gradle',
                },
                {
                    name: 'junit:junit',
                    version: '4.13.2',
                    ecosystem: 'gradle',
                    sourceFile: 'build.gradle',
                },
            ]);
        });

        it('returns [] when no dependency declarations match', () => {
            expect(
                call('parseGradle', 'build.gradle', 'plugins { id "java" }'),
            ).toEqual([]);
        });
    });

    describe('parseGoMod', () => {
        it('parses indented require entries and skips module/go/comments/blocks', () => {
            const content = [
                'module github.com/example/project',
                '',
                'go 1.20',
                '',
                'require (',
                '    github.com/foo/bar v1.2.3',
                '    // a comment',
                '    golang.org/x/text v0.3.7',
                ')',
            ].join('\n');

            expect(call('parseGoMod', 'go.mod', content)).toEqual([
                {
                    name: 'github.com/foo/bar',
                    version: 'v1.2.3',
                    ecosystem: 'go',
                    sourceFile: 'go.mod',
                },
                {
                    name: 'golang.org/x/text',
                    version: 'v0.3.7',
                    ecosystem: 'go',
                    sourceFile: 'go.mod',
                },
            ]);
        });

        it('returns [] when there are no dependency lines', () => {
            expect(call('parseGoMod', 'go.mod', 'module x\ngo 1.20\n')).toEqual(
                [],
            );
        });
    });

    describe('parseCargoToml', () => {
        it('parses string and table dependency forms', () => {
            const content = [
                '[dependencies]',
                'serde = "1.0"',
                'tokio = { version = "1.28", features = ["full"] }',
            ].join('\n');

            expect(call('parseCargoToml', 'Cargo.toml', content)).toEqual([
                {
                    name: 'serde',
                    version: '1.0',
                    ecosystem: 'cargo',
                    sourceFile: 'Cargo.toml',
                },
                {
                    name: 'tokio',
                    version: '1.28',
                    ecosystem: 'cargo',
                    sourceFile: 'Cargo.toml',
                },
            ]);
        });

        it('returns [] when there is no dependencies table', () => {
            expect(
                call('parseCargoToml', 'Cargo.toml', '[package]\nname = "x"'),
            ).toEqual([]);
        });

        it('returns [] on invalid TOML (catch fallback)', () => {
            expect(
                call('parseCargoToml', 'Cargo.toml', 'this = = invalid'),
            ).toEqual([]);
        });
    });

    describe('parseGemfile', () => {
        it('parses gems with and without a version constraint', () => {
            const content = ["gem 'rails', '~> 7.0'", 'gem "puma"'].join('\n');

            expect(call('parseGemfile', 'Gemfile', content)).toEqual([
                {
                    name: 'rails',
                    version: '~> 7.0',
                    ecosystem: 'ruby',
                    sourceFile: 'Gemfile',
                },
                {
                    name: 'puma',
                    version: undefined,
                    ecosystem: 'ruby',
                    sourceFile: 'Gemfile',
                },
            ]);
        });

        it('returns [] when there are no gem declarations', () => {
            expect(
                call(
                    'parseGemfile',
                    'Gemfile',
                    "source 'https://rubygems.org'",
                ),
            ).toEqual([]);
        });
    });
});
