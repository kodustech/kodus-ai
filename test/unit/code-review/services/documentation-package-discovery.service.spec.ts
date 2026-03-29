import { IPullRequestManagerService } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { DocumentationPackageDiscoveryService } from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';

describe('DocumentationPackageDiscoveryService', () => {
    let service: DocumentationPackageDiscoveryService;
    let pullRequestManager: jest.Mocked<IPullRequestManagerService>;

    beforeEach(() => {
        pullRequestManager = {
            enrichFilesWithContent: jest.fn(),
        } as unknown as jest.Mocked<IPullRequestManagerService>;

        service = new DocumentationPackageDiscoveryService(pullRequestManager);
    });

    it('should discover packages from changed manifest files', async () => {
        const context = {
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
            repository: { id: 'r1', name: 'repo' },
            pullRequest: { number: 10 },
            changedFiles: [
                {
                    filename: 'package.json',
                    fileContent: JSON.stringify({
                        dependencies: {
                            '@nestjs/common': '^10.0.0',
                            'react': '^18.0.0',
                        },
                        devDependencies: {
                            jest: '^29.0.0',
                        },
                    }),
                },
                {
                    filename: 'requirements.txt',
                    fileContent: 'fastapi==0.115.0\nuvicorn>=0.30.0\n',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        pullRequestManager.enrichFilesWithContent.mockResolvedValue([] as any);

        const result = await service.discoverPackages(context);

        expect(result.packages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                }),
                expect.objectContaining({
                    name: 'fastapi',
                    ecosystem: 'pip',
                }),
            ]),
        );
    });

    it('should fetch missing root manifest candidates and parse them', async () => {
        const context = {
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
            repository: { id: 'r1', name: 'repo' },
            pullRequest: { number: 11 },
            changedFiles: [
                {
                    filename: 'src/app.service.ts',
                    fileContent: 'export class AppService {}',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        pullRequestManager.enrichFilesWithContent.mockResolvedValue([
            {
                filename: 'go.mod',
                fileContent:
                    'module example.com/demo\n\nrequire (\n  github.com/gin-gonic/gin v1.10.0\n)\n',
            },
            {
                filename: 'Gemfile',
                fileContent: "gem 'rails', '~> 7.1.0'\n",
            },
        ] as any);

        const result = await service.discoverPackages(context);

        expect(pullRequestManager.enrichFilesWithContent).toHaveBeenCalled();
        expect(result.packages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'github.com/gin-gonic/gin',
                    ecosystem: 'go',
                }),
                expect.objectContaining({
                    name: 'rails',
                    ecosystem: 'ruby',
                }),
            ]),
        );
    });

    it('should fetch and keep workspace manifests for monorepo folders', async () => {
        const context = {
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
            repository: { id: 'r1', name: 'repo' },
            pullRequest: { number: 12 },
            changedFiles: [
                {
                    filename: 'apps/api/src/example.controller.ts',
                    fileContent: 'export class ExampleController {}',
                },
                {
                    filename: 'apps/web/src/app/page.tsx',
                    fileContent:
                        'export default function Page() { return null; }',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        pullRequestManager.enrichFilesWithContent.mockResolvedValue([
            {
                filename: 'apps/api/package.json',
                fileContent: JSON.stringify({
                    dependencies: {
                        '@nestjs/common': '^10.0.0',
                    },
                }),
            },
            {
                filename: 'apps/web/package.json',
                fileContent: JSON.stringify({
                    dependencies: {
                        next: '^15.0.0',
                    },
                }),
            },
        ] as any);

        const result = await service.discoverPackages(context);

        expect(pullRequestManager.enrichFilesWithContent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.arrayContaining([
                expect.objectContaining({ filename: 'apps/api/package.json' }),
                expect.objectContaining({ filename: 'apps/web/package.json' }),
            ]),
        );

        expect(result.packages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'apps/api/package.json',
                }),
                expect.objectContaining({
                    name: 'next',
                    ecosystem: 'npm',
                    sourceFile: 'apps/web/package.json',
                }),
            ]),
        );
    });

    it('should use sandbox ripgrep output to discover manifest files', async () => {
        const context = {
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
            repository: { id: 'r1', name: 'repo' },
            pullRequest: { number: 13 },
            changedFiles: [
                {
                    filename: 'apps/api/src/example.controller.ts',
                    fileContent: 'export class ExampleController {}',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        const grepMock = jest.fn(
            async (_pattern: string, _path: string, glob?: string) => {
                if (glob === '**/package.json') {
                    return './apps/api/package.json:1:{"dependencies":{"@nestjs/common":"^10.0.0"}}\n';
                }
                return '';
            },
        );

        pullRequestManager.enrichFilesWithContent.mockResolvedValue([
            {
                filename: 'apps/api/package.json',
                fileContent: JSON.stringify({
                    dependencies: {
                        '@nestjs/common': '^10.0.0',
                    },
                }),
            },
        ] as any);

        const result = await service.discoverPackages(context, {
            remoteCommands: {
                grep: grepMock,
                read: jest.fn(),
                listDir: jest.fn(),
            },
        });

        expect(grepMock).toHaveBeenCalledWith('.', '.', '**/package.json');
        expect(result.manifestFiles).toContain('apps/api/package.json');
        expect(result.packages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: '@nestjs/common',
                    sourceFile: 'apps/api/package.json',
                }),
            ]),
        );
    });

    it('should parse all supported manifest file formats', async () => {
        const context = {
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
            repository: { id: 'r1', name: 'repo' },
            pullRequest: { number: 14 },
            changedFiles: [
                {
                    filename: 'package.json',
                    fileContent: JSON.stringify({
                        dependencies: {
                            react: '^18.3.1',
                        },
                    }),
                },
                {
                    filename: 'requirements.txt',
                    fileContent: 'fastapi==0.115.0\nuvicorn>=0.30.0\n',
                },
                {
                    filename: 'pyproject.toml',
                    fileContent: `
[project]
dependencies = [
  "django>=5.0.0",
  "pydantic==2.8.2"
]

[project.optional-dependencies]
dev = ["pytest>=8.0.0"]

[tool.poetry.dependencies]
python = "^3.12"
httpx = "^0.27.0"
`,
                },
                {
                    filename: 'pom.xml',
                    fileContent: `
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.3.2</version>
    </dependency>
  </dependencies>
</project>
`,
                },
                {
                    filename: 'build.gradle',
                    fileContent: `
dependencies {
  implementation 'org.apache.commons:commons-lang3:3.14.0'
}
`,
                },
                {
                    filename: 'build.gradle.kts',
                    fileContent: `
dependencies {
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
`,
                },
                {
                    filename: 'go.mod',
                    fileContent: `
module example.com/myapp

go 1.22

require (
  github.com/gin-gonic/gin v1.10.0
)
`,
                },
                {
                    filename: 'Cargo.toml',
                    fileContent: `
[dependencies]
serde = "1.0.210"
tokio = { version = "1.39.2", features = ["macros", "rt-multi-thread"] }
`,
                },
                {
                    filename: 'Gemfile',
                    fileContent: `
source 'https://rubygems.org'
gem 'rails', '~> 7.1.0'
gem 'pg'
`,
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        pullRequestManager.enrichFilesWithContent.mockResolvedValue([] as any);

        const result = await service.discoverPackages(context);

        expect(result.manifestFiles).toEqual(
            expect.arrayContaining([
                'package.json',
                'requirements.txt',
                'pyproject.toml',
                'pom.xml',
                'build.gradle',
                'build.gradle.kts',
                'go.mod',
                'Cargo.toml',
                'Gemfile',
            ]),
        );

        expect(result.packages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'react',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                }),
                expect.objectContaining({
                    name: 'fastapi',
                    ecosystem: 'pip',
                    sourceFile: 'requirements.txt',
                }),
                expect.objectContaining({
                    name: 'django',
                    ecosystem: 'pip',
                    sourceFile: 'pyproject.toml',
                }),
                expect.objectContaining({
                    name: 'httpx',
                    ecosystem: 'pip',
                    sourceFile: 'pyproject.toml',
                }),
                expect.objectContaining({
                    name: 'org.springframework.boot:spring-boot-starter-web',
                    ecosystem: 'maven',
                    sourceFile: 'pom.xml',
                }),
                expect.objectContaining({
                    name: 'org.apache.commons:commons-lang3',
                    ecosystem: 'gradle',
                    sourceFile: 'build.gradle',
                }),
                expect.objectContaining({
                    name: 'com.squareup.okhttp3:okhttp',
                    ecosystem: 'gradle',
                    sourceFile: 'build.gradle.kts',
                }),
                expect.objectContaining({
                    name: 'github.com/gin-gonic/gin',
                    ecosystem: 'go',
                    sourceFile: 'go.mod',
                }),
                expect.objectContaining({
                    name: 'serde',
                    ecosystem: 'cargo',
                    sourceFile: 'Cargo.toml',
                }),
                expect.objectContaining({
                    name: 'tokio',
                    ecosystem: 'cargo',
                    sourceFile: 'Cargo.toml',
                }),
                expect.objectContaining({
                    name: 'rails',
                    ecosystem: 'ruby',
                    sourceFile: 'Gemfile',
                }),
            ]),
        );
    });

    it('should fail open for invalid manifest contents and continue parsing valid files', async () => {
        const context = {
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
            repository: { id: 'r1', name: 'repo' },
            pullRequest: { number: 15 },
            changedFiles: [
                {
                    filename: 'package.json',
                    fileContent: '{"dependencies": {"react": "^18.3.1"}',
                },
                {
                    filename: 'pyproject.toml',
                    fileContent:
                        '[project\ndependencies = ["fastapi>=0.115.0"]',
                },
                {
                    filename: 'Cargo.toml',
                    fileContent: '[dependencies\nserde = "1.0"',
                },
                {
                    filename: 'pom.xml',
                    fileContent:
                        '<project><dependencies><dependency><groupId>org.springframework.boot</groupId>',
                },
                {
                    filename: 'build.gradle',
                    fileContent:
                        "implementation 'org.apache.commons:commons-lang3:3.14.0'",
                },
                {
                    filename: 'go.mod',
                    fileContent:
                        'module example.com/myapp\n\nrequire (\n  github.com/gin-gonic/gin v1.10.0\n)\n',
                },
                {
                    filename: 'Gemfile',
                    fileContent: "gem 'rails', '~> 7.1.0'",
                },
                {
                    filename: 'requirements.txt',
                    fileContent: 'fastapi==0.115.0\n',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        pullRequestManager.enrichFilesWithContent.mockResolvedValue([] as any);

        await expect(service.discoverPackages(context)).resolves.toBeDefined();

        const result = await service.discoverPackages(context);

        expect(result.packages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'org.apache.commons:commons-lang3',
                    ecosystem: 'gradle',
                    sourceFile: 'build.gradle',
                }),
                expect.objectContaining({
                    name: 'github.com/gin-gonic/gin',
                    ecosystem: 'go',
                    sourceFile: 'go.mod',
                }),
                expect.objectContaining({
                    name: 'rails',
                    ecosystem: 'ruby',
                    sourceFile: 'Gemfile',
                }),
                expect.objectContaining({
                    name: 'fastapi',
                    ecosystem: 'pip',
                    sourceFile: 'requirements.txt',
                }),
            ]),
        );

        expect(
            result.packages.some((pkg) => pkg.sourceFile === 'package.json'),
        ).toBe(false);
        expect(
            result.packages.some((pkg) => pkg.sourceFile === 'pyproject.toml'),
        ).toBe(false);
        expect(
            result.packages.some((pkg) => pkg.sourceFile === 'Cargo.toml'),
        ).toBe(false);
    });
});
