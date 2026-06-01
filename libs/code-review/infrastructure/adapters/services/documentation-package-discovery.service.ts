export const DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN = Symbol.for(
    'DocumentationPackageDiscoveryService',
);

import { createLogger } from '@kodus/flow';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    CodeReviewPipelineContext,
    RepositoryPackageReference,
} from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Inject, Injectable } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { parse as parseToml } from 'smol-toml';

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

@Injectable()
export class DocumentationPackageDiscoveryService {
    private readonly logger = createLogger(
        DocumentationPackageDiscoveryService.name,
    );

    constructor(
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestManager: IPullRequestManagerService,
    ) {}

    async discoverPackages(
        context: CodeReviewPipelineContext,
        options?: { remoteCommands?: RemoteCommands },
    ): Promise<{
        packages: RepositoryPackageReference[];
        manifestFiles: string[];
    }> {
        if (!context.changedFiles?.length) {
            return { packages: [], manifestFiles: [] };
        }

        const manifestsByPath = new Map<string, string>();
        for (const file of context.changedFiles) {
            if (
                this.isSupportedManifestFile(file.filename) &&
                file.fileContent
            ) {
                manifestsByPath.set(file.filename, file.fileContent);
            }
        }

        const candidatesToFetch = new Set<string>();

        const manifestCandidatesFromRipgrep =
            await this.discoverManifestCandidatesWithRipgrep(
                options?.remoteCommands,
                context,
            );

        for (const candidate of manifestCandidatesFromRipgrep) {
            candidatesToFetch.add(candidate);
        }

        if (!manifestCandidatesFromRipgrep.length) {
            for (const file of context.changedFiles) {
                for (const candidate of this.buildManifestCandidatesForFile(
                    file.filename,
                )) {
                    candidatesToFetch.add(candidate);
                }
            }
        }

        for (const file of context.changedFiles) {
            if (this.isSupportedManifestFile(file.filename)) {
                candidatesToFetch.add(file.filename);
            }
        }

        const missingCandidates = [...candidatesToFetch].filter(
            (candidate) => !manifestsByPath.has(candidate),
        );

        if (missingCandidates.length > 0) {
            try {
                const filesToFetch = missingCandidates.map(
                    (filename) =>
                        ({
                            filename,
                            sha: '',
                            status: 'modified',
                            additions: 0,
                            deletions: 0,
                            changes: 0,
                            blob_url: '',
                            raw_url: '',
                            contents_url: '',
                            content: null,
                        }) as FileChange,
                );

                const fetched =
                    await this.pullRequestManager.enrichFilesWithContent(
                        context.organizationAndTeamData,
                        context.repository,
                        context.pullRequest,
                        filesToFetch,
                    );

                for (const file of fetched) {
                    if (
                        file.fileContent &&
                        this.isSupportedManifestFile(file.filename)
                    ) {
                        manifestsByPath.set(file.filename, file.fileContent);
                    }
                }
            } catch (error) {
                this.logger.warn({
                    message:
                        'Failed to fetch one or more manifest files, continuing with available files',
                    context: DocumentationPackageDiscoveryService.name,
                    error,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest?.number,
                        repository: context.repository?.name,
                    },
                });
            }
        }

        const packageMap = new Map<string, RepositoryPackageReference>();

        for (const [manifestPath, content] of manifestsByPath.entries()) {
            const parsed = this.parseManifest(manifestPath, content);
            for (const pkg of parsed) {
                const key =
                    `${pkg.ecosystem}:${pkg.name}:${pkg.sourceFile}`.toLowerCase();
                const current = packageMap.get(key);
                if (!current || (!current.version && pkg.version)) {
                    packageMap.set(key, pkg);
                }
            }
        }

        return {
            packages: [...packageMap.values()],
            manifestFiles: [...manifestsByPath.keys()],
        };
    }

    private isSupportedManifestFile(filePath: string): boolean {
        const baseName = path.posix.basename(filePath);
        return ROOT_MANIFEST_FILES.includes(baseName);
    }

    private async discoverManifestCandidatesWithRipgrep(
        remoteCommands?: RemoteCommands,
        context?: Pick<
            CodeReviewPipelineContext,
            'organizationAndTeamData' | 'pullRequest' | 'repository'
        >,
    ): Promise<string[]> {
        if (!remoteCommands) {
            return [];
        }

        const discovered = new Set<string>();

        try {
            const settledResults = await Promise.allSettled(
                ROOT_MANIFEST_FILES.map(async (manifestFile) => {
                    const rgOutput = await remoteCommands.grep(
                        '.',
                        '.',
                        `**/${manifestFile}`,
                    );

                    return { manifestFile, rgOutput };
                }),
            );

            for (const settledResult of settledResults) {
                if (settledResult.status === 'rejected') {
                    const error = settledResult.reason as {
                        exitCode?: number;
                    };

                    if (error?.exitCode === 1) {
                        // No matches found, not an error in this context
                        continue;
                    }

                    throw settledResult.reason;
                }

                const { manifestFile, rgOutput } = settledResult.value;

                for (const pathFromLine of this.extractPathsFromRipgrepOutput(
                    rgOutput,
                )) {
                    if (path.posix.basename(pathFromLine) === manifestFile) {
                        discovered.add(pathFromLine);
                    }
                }
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Ripgrep manifest discovery failed in sandbox, falling back to path-based candidates',
                context: DocumentationPackageDiscoveryService.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                    repository: context?.repository?.name,
                },
                error,
            });
            return [];
        }

        return [...discovered];
    }

    private extractPathsFromRipgrepOutput(output: string): string[] {
        const paths = new Set<string>();

        for (const line of (output || '').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            const match = trimmed.match(/^([^:]+):\d+:/);
            if (!match) {
                continue;
            }

            const normalizedPath = match[1].replace(/^\.\//, '');
            if (normalizedPath) {
                paths.add(normalizedPath);
            }
        }

        return [...paths];
    }

    private buildManifestCandidatesForFile(filePath: string): string[] {
        const candidates = new Set<string>();
        let currentDir = this.normalizeDirectory(path.posix.dirname(filePath));

        while (true) {
            for (const manifestFile of ROOT_MANIFEST_FILES) {
                const candidatePath = currentDir
                    ? path.posix.join(currentDir, manifestFile)
                    : manifestFile;
                candidates.add(candidatePath);
            }

            if (!currentDir) {
                break;
            }

            currentDir = this.normalizeDirectory(
                path.posix.dirname(currentDir),
            );
        }

        return [...candidates];
    }

    private normalizeDirectory(directory: string): string {
        if (!directory || directory === '.' || directory === '/') {
            return '';
        }

        return directory.replace(/^\/+|\/+$/g, '');
    }

    private parseManifest(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        const baseName = path.posix.basename(filePath);

        switch (baseName) {
            case 'package.json':
                return this.parsePackageJson(filePath, content);
            case 'requirements.txt':
                return this.parseRequirementsTxt(filePath, content);
            case 'pyproject.toml':
                return this.parsePyprojectToml(filePath, content);
            case 'pom.xml':
                return this.parsePomXml(filePath, content);
            case 'build.gradle':
            case 'build.gradle.kts':
                return this.parseGradle(filePath, content);
            case 'go.mod':
                return this.parseGoMod(filePath, content);
            case 'Cargo.toml':
                return this.parseCargoToml(filePath, content);
            case 'Gemfile':
                return this.parseGemfile(filePath, content);
            default:
                return [];
        }
    }

    private parsePackageJson(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        try {
            const parsed = JSON.parse(content);
            const sections = [
                parsed.dependencies,
                parsed.devDependencies,
                parsed.peerDependencies,
                parsed.optionalDependencies,
            ];

            const packages: RepositoryPackageReference[] = [];
            for (const section of sections) {
                if (!section || typeof section !== 'object') {
                    continue;
                }

                for (const [name, version] of Object.entries(section)) {
                    packages.push({
                        name,
                        version: this.normalizeVersion(String(version ?? '')),
                        ecosystem: 'npm',
                        sourceFile: filePath,
                    });
                }
            }

            return packages;
        } catch {
            return [];
        }
    }

    private parseRequirementsTxt(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        return content
            .split('\n')
            .map((line) => line.trim())
            .filter(
                (line) =>
                    line && !line.startsWith('#') && !line.startsWith('-'),
            )
            .map((line) => {
                const match = line.match(
                    /^([A-Za-z0-9._\-[\]]+)(?:\s*(?:==|>=|<=|~=|>|<)\s*([^\s;]+))?/,
                );
                if (!match) {
                    return null;
                }
                return {
                    name: match[1],
                    version: this.normalizeVersion(match[2]),
                    ecosystem: 'pip' as const,
                    sourceFile: filePath,
                };
            })
            .filter(Boolean) as RepositoryPackageReference[];
    }

    private parsePyprojectToml(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        try {
            const doc = parseToml(content) as Record<string, any>;
            const packages: RepositoryPackageReference[] = [];

            const projectDependencies =
                doc?.project?.dependencies &&
                Array.isArray(doc.project.dependencies)
                    ? doc.project.dependencies
                    : [];

            for (const dep of projectDependencies) {
                const parsed = this.parsePythonRequirementSpec(
                    String(dep),
                    filePath,
                );
                if (parsed) {
                    packages.push(parsed);
                }
            }

            const projectOptionalDependencies =
                doc?.project?.['optional-dependencies'] || {};
            for (const deps of Object.values(projectOptionalDependencies)) {
                if (!Array.isArray(deps)) {
                    continue;
                }
                for (const dep of deps) {
                    const parsed = this.parsePythonRequirementSpec(
                        String(dep),
                        filePath,
                    );
                    if (parsed) {
                        packages.push(parsed);
                    }
                }
            }

            const poetryDependencies =
                doc?.tool?.poetry?.dependencies || ({} as Record<string, any>);

            for (const [name, value] of Object.entries(poetryDependencies)) {
                if (name.toLowerCase() === 'python') {
                    continue;
                }

                const version =
                    typeof value === 'string'
                        ? value
                        : (value as Record<string, any>)?.version;

                packages.push({
                    name,
                    version: this.normalizeVersion(version),
                    ecosystem: 'pip',
                    sourceFile: filePath,
                });
            }

            return packages;
        } catch {
            return [];
        }
    }

    private parsePomXml(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        const parser = new XMLParser();
        const jsonObj = parser.parse(content);

        // Maven files can have a single dependency or an array
        const deps = jsonObj.project?.dependencies?.dependency;
        if (!deps) return [];

        const depArray = Array.isArray(deps) ? deps : [deps];

        return depArray.map((dep) => ({
            name: `${dep.groupId}:${dep.artifactId}`,
            version: this.normalizeVersion(String(dep.version ?? '')),
            ecosystem: 'maven',
            sourceFile: filePath,
        }));
    }

    private parseGradle(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        const regex =
            /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|kapt)\s*\(?\s*['"]([^:'"]+):([^:'"]+):([^'"]+)['"]/g;
        const packages: RepositoryPackageReference[] = [];

        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            packages.push({
                name: `${match[1]}:${match[2]}`,
                version: this.normalizeVersion(match[3]),
                ecosystem: 'gradle',
                sourceFile: filePath,
            });
        }

        return packages;
    }

    private parseGoMod(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        const packages: RepositoryPackageReference[] = [];
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (
                !trimmed ||
                trimmed.startsWith('//') ||
                trimmed === 'require ('
            ) {
                continue;
            }

            const match = trimmed.match(/^([\w./-]+)\s+([\w.+\-/]+)$/);
            if (!match) {
                continue;
            }

            if (
                match[1] === 'module' ||
                match[1] === 'go' ||
                match[1] === ')'
            ) {
                continue;
            }

            packages.push({
                name: match[1],
                version: this.normalizeVersion(match[2]),
                ecosystem: 'go',
                sourceFile: filePath,
            });
        }

        return packages;
    }

    private parseCargoToml(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        try {
            const doc = parseToml(content);
            const deps = doc.dependencies || {};

            return Object.entries(deps).map(([name, value]) => {
                // Handle: package = "1.0" OR package = { version = "1.0", features = [...] }
                const version =
                    typeof value === 'string' ? value : (value as any).version;
                return {
                    name,
                    version: this.normalizeVersion(version),
                    ecosystem: 'cargo',
                    sourceFile: filePath,
                };
            });
        } catch {
            return [];
        }
    }

    private parseGemfile(
        filePath: string,
        content: string,
    ): RepositoryPackageReference[] {
        const regex = /gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/g;
        const packages: RepositoryPackageReference[] = [];

        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            packages.push({
                name: match[1],
                version: this.normalizeVersion(match[2]),
                ecosystem: 'ruby',
                sourceFile: filePath,
            });
        }

        return packages;
    }

    private normalizeVersion(version?: string): string | undefined {
        if (!version) {
            return undefined;
        }

        const normalized = version.trim();
        return normalized.length > 0 ? normalized : undefined;
    }

    private parsePythonRequirementSpec(
        spec: string,
        filePath: string,
    ): RepositoryPackageReference | null {
        const normalized = spec.trim();
        if (!normalized) {
            return null;
        }

        const match = normalized.match(
            /^([A-Za-z0-9._\-[\]]+)(?:\s*(?:==|>=|<=|~=|>|<)\s*([^\s;]+))?/,
        );

        if (!match) {
            return null;
        }

        return {
            name: match[1],
            version: this.normalizeVersion(match[2]),
            ecosystem: 'pip',
            sourceFile: filePath,
        };
    }
}
