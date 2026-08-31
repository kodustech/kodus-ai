import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';

import { ResolveConfigStage } from './resolve-config.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import {
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import {
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

/**
 * Input-contract spec for ResolveConfigStage — the stage that resolves the
 * codeReviewConfig the downstream LLM review actually runs on. Guards the
 * data each dependency call REQUIRES (org / repo / PR / baseCommit threaded),
 * the fail-safe SKIP paths (never throw), and that the config feeding the
 * review is derived from the right inputs. Mocks every collaborator — no
 * network, no LLM.
 */
describe('ResolveConfigStage — input contract', () => {
    let stage: ResolveConfigStage;
    let codeBaseConfig: { getConfig: jest.Mock };
    let prManager: { getChangedFilesMetadata: jest.Mock };
    let prMessages: { findOne: jest.Mock };
    let parameters: { findByKey: jest.Mock };
    let moduleRef: { resolve: jest.Mock };

    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const REPO = { id: 'repo-1', name: 'tiny-url' };
    const PR = { number: 42 };
    const FILES = [{ filename: 'a.ts' }];

    const buildContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            organizationAndTeamData: ORG,
            repository: REPO,
            pullRequest: PR,
            ...overrides,
        }) as unknown as CodeReviewPipelineContext;

    beforeEach(async () => {
        codeBaseConfig = { getConfig: jest.fn().mockResolvedValue({ id: 'cfg' }) };
        prManager = {
            getChangedFilesMetadata: jest.fn().mockResolvedValue(FILES),
        };
        prMessages = { findOne: jest.fn().mockResolvedValue(null) };
        parameters = { findByKey: jest.fn().mockResolvedValue(null) };
        moduleRef = { resolve: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ResolveConfigStage,
                { provide: CODE_BASE_CONFIG_SERVICE_TOKEN, useValue: codeBaseConfig },
                { provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN, useValue: prManager },
                { provide: PULL_REQUEST_MESSAGES_SERVICE_TOKEN, useValue: prMessages },
                { provide: PARAMETERS_SERVICE_TOKEN, useValue: parameters },
                { provide: ModuleRef, useValue: moduleRef },
            ],
        }).compile();

        stage = module.get(ResolveConfigStage);
    });

    it('threads org + repo + PR into getChangedFilesMetadata, with the last analyzed commit as base', async () => {
        const context = buildContext({
            lastExecution: { lastAnalyzedCommit: 'sha-prev' },
        } as any);

        await stage.execute(context);

        expect(prManager.getChangedFilesMetadata).toHaveBeenCalledWith(
            ORG,
            REPO,
            PR,
            'sha-prev',
        );
    });

    it('forceFullRerun drops the base commit (re-reads the whole PR)', async () => {
        const context = buildContext({
            lastExecution: { lastAnalyzedCommit: 'sha-prev' },
            pipelineMetadata: { forceFullRerun: true },
        } as any);

        await stage.execute(context);

        expect(prManager.getChangedFilesMetadata).toHaveBeenCalledWith(
            ORG,
            REPO,
            PR,
            undefined,
        );
    });

    it('derives the review config from (org, repo, preliminaryFiles) and stamps it on the context', async () => {
        const result = await stage.execute(buildContext());

        // The config the LLM review runs on is built from the resolved inputs.
        expect(codeBaseConfig.getConfig).toHaveBeenCalledWith(ORG, REPO, FILES);
        expect(result.codeReviewConfig).toEqual({ id: 'cfg' });
        expect(result.preliminaryFiles).toBe(FILES);
    });

    it('SKIPS (never builds a config) when the PR has no files', async () => {
        prManager.getChangedFilesMetadata.mockResolvedValue([]);

        const result = await stage.execute(buildContext());

        expect(result.statusInfo).toEqual({
            status: AutomationStatus.SKIPPED,
            message: AutomationMessage.NO_FILES_IN_PR,
        });
        expect(codeBaseConfig.getConfig).not.toHaveBeenCalled();
    });

    it('degrades to SKIPPED (never throws) when config resolution fails', async () => {
        codeBaseConfig.getConfig.mockRejectedValue(new Error('boom'));

        const result = await stage.execute(buildContext());

        expect(result.statusInfo).toEqual({
            status: AutomationStatus.SKIPPED,
            message: AutomationMessage.FAILED_RESOLVE_CONFIG,
        });
    });

    it('runs the centralized-config sync ONLY when it is enabled', async () => {
        // disabled → no sync resolution
        await stage.execute(buildContext());
        expect(parameters.findByKey).toHaveBeenCalledWith(
            ParametersKey.CENTRALIZED_CONFIG,
            ORG,
        );
        expect(moduleRef.resolve).not.toHaveBeenCalled();

        // enabled → resolves + executes the sync use-case
        const syncExec = jest.fn().mockResolvedValue(undefined);
        parameters.findByKey.mockResolvedValue({ configValue: { enabled: true } });
        moduleRef.resolve.mockResolvedValue({ execute: syncExec });

        await stage.execute(buildContext());
        expect(moduleRef.resolve).toHaveBeenCalled();
        expect(syncExec).toHaveBeenCalledWith({ organizationAndTeamData: ORG });
    });

    it('a failing centralized sync never breaks the stage (falls back to DB config)', async () => {
        parameters.findByKey.mockResolvedValue({ configValue: { enabled: true } });
        moduleRef.resolve.mockRejectedValue(new Error('sync down'));

        const result = await stage.execute(buildContext());

        // still resolves the config despite the sync failure
        expect(codeBaseConfig.getConfig).toHaveBeenCalled();
        expect(result.codeReviewConfig).toEqual({ id: 'cfg' });
    });

    it('resolves PR-message config through the repository→global fallback (scoped by org + repo)', async () => {
        const result = await stage.execute(buildContext());

        // no directory-level config on the incoming context → repository scope first
        expect(prMessages.findOne).toHaveBeenCalledWith({
            organizationId: ORG.organizationId,
            repositoryId: REPO.id,
            configLevel: ConfigLevel.REPOSITORY,
        });
        // repository returned null → falls back to global
        expect(prMessages.findOne).toHaveBeenCalledWith({
            organizationId: ORG.organizationId,
            configLevel: ConfigLevel.GLOBAL,
        });
        expect(result.pullRequestMessagesConfig).toBeNull();
    });
});
