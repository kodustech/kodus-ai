import { Test, TestingModule } from '@nestjs/testing';

import { CodeManagementService } from '@libs/platform/infrastructure/services/codeManagement.service';

import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PullRequestHandlerService } from '@/core/infrastructure/adapters/services/codeBase/pullRequestManager.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CacheService } from '@/shared/utils/cache/cache.service';
import * as globalPathsJsonFile from '@/shared/utils/codeBase/ignorePaths/generated/paths.json';

describe('pullRequestManager', () => {
    const globalFilePaths = globalPathsJsonFile.paths;

    let pullRequestManagerService: PullRequestHandlerService;

    const mockCodeManagmentService = {
        getFilesByPullRequestId: jest.fn(),
        getRepositoryContentFile: jest.fn(),
    };

    const mockLogger = {};

    const mockCacheService = {
        addToCache: jest.fn(),
        getFromCache: jest.fn(),
        removeFromCache: jest.fn(),
        clearCache: jest.fn(),
        cacheExists: jest.fn(),
        getMultipleFromCache: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PullRequestHandlerService,
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagmentService,
                },
                {
                    provide: PinoLoggerService,
                    useValue: mockLogger,
                },
                {
                    provide: CacheService,
                    useValue: mockCacheService,
                },
            ],
        }).compile();

        pullRequestManagerService = module.get<PullRequestHandlerService>(
            PullRequestHandlerService,
        );
    });

    it('should be defined', () => {
        expect(pullRequestManagerService).toBeDefined();
    });

    const MOCK_ORGANIZATION_AND_TEAM_DATA: OrganizationAndTeamData = {
        organizationId: 'organizationId',
        teamId: 'teamId',
    };

    const MOCK_REPOSITORY_DATA = {
        name: 'repositoryName',
        id: 'repositoryId',
    };

    const MOCK_PULL_REQUEST_DATA = {
        number: 1,
    };

    const MOCK_FILE_CHANGE_DATA = [
        {
            filename: 'src/file1',
            sha: 'sha1',
            status: 'status of file1',
            additions: 1,
            deletions: 2,
            changes: 3,
            patch: 'patch of file1',
            fileContent: 'content of file1',
        },
        {
            filename: 'temp/file2',
            sha: 'sha2',
            status: 'status of file2',
            additions: 2,
            deletions: 3,
            changes: 5,
            patch: 'patch of file2',
            fileContent: 'content of file1',
        },
        {
            filename: 'src/foo/file3',
            sha: 'sha3',
            status: 'status of file3',
            additions: 3,
            deletions: 4,
            changes: 7,
            patch: 'patch of file3',
            fileContent: 'content of file1',
        },
    ];

    const MOCK_FILE_CONTENT_DATA = MOCK_FILE_CHANGE_DATA.map((file) => ({
        data: {
            content: btoa(file.fileContent),
            encoding: 'base64',
        },
    }));

    const MOCK_IGNORE_PATHS = globalFilePaths.concat(['**/foo/*']);

    it('should return filtered files correctly', async () => {
        mockCodeManagmentService.getFilesByPullRequestId.mockResolvedValueOnce(
            MOCK_FILE_CHANGE_DATA,
        );

        MOCK_FILE_CONTENT_DATA.forEach((fileContent) => {
            mockCodeManagmentService.getRepositoryContentFile.mockResolvedValueOnce(
                fileContent,
            );
        });

        const result = await pullRequestManagerService.getChangedFiles(
            MOCK_ORGANIZATION_AND_TEAM_DATA,
            MOCK_REPOSITORY_DATA,
            MOCK_PULL_REQUEST_DATA,
            MOCK_IGNORE_PATHS,
        );

        expect(result).toEqual([MOCK_FILE_CHANGE_DATA[0]]);
    });
});
