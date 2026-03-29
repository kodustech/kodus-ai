import * as fs from 'fs';
import * as path from 'path';

import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';

describe('SkillLoaderService', () => {
    it('loads instructions from SKILL.md for business-rules-validation', () => {
        const service = new SkillLoaderService();

        const instructions = service.loadInstructions(
            'business-rules-validation',
        );

        expect(instructions).toContain('# Business Rules Gap Analysis');
        expect(instructions).not.toContain('## Reference Material');
    });

    it('loads business-rules instructions that require diff-grounded evidence wording', () => {
        const service = new SkillLoaderService();

        const instructions = service.loadInstructions(
            'business-rules-validation',
        );

        expect(instructions).toContain('No evidence in this PR diff');
        expect(instructions).toContain('scope mismatch');
        expect(instructions).toContain(
            'Do not state current system or backend behavior as fact unless that behavior appears in the PR_DIFF',
        );
    });

    it('loads business-rules instructions that require intent and alignment analysis before detailed findings', () => {
        const service = new SkillLoaderService();

        const instructions = service.loadInstructions(
            'business-rules-validation',
        );

        expect(instructions).toContain('Task Intent');
        expect(instructions).toContain('PR Intent');
        expect(instructions).toContain('Alignment');
        expect(instructions).toContain('scope_mismatch');
    });

    it('loads business-rules instructions that enforce generated prose in USER LANGUAGE', () => {
        const service = new SkillLoaderService();

        const instructions = service.loadInstructions(
            'business-rules-validation',
        );

        expect(instructions).toContain(
            'Write all generated prose, headings, status labels, findings, explanations, and suggested actions in `USER LANGUAGE`.',
        );
        expect(instructions).toContain(
            'Only quoted requirement text copied from the task may remain in the original source language.',
        );
        expect(instructions).toContain(
            'Do not mix languages in generated prose.',
        );
    });

    it('loads business-rules instructions that omit empty verification sections and include task reference details', () => {
        const service = new SkillLoaderService();

        const instructions = service.loadInstructions(
            'business-rules-validation',
        );

        expect(instructions).toContain(
            'If no task requirements were verified from the diff, omit the "Requirements Verified" section entirely.',
        );
        expect(instructions).toContain(
            'Include a short task reference near the top of the summary when task id, title, or link is available.',
        );
    });

    it('loads skill metadata from SKILL.md frontmatter', () => {
        const service = new SkillLoaderService();

        const meta = service.loadSkillMetaFromFilesystem(
            'business-rules-validation',
        );

        expect(meta.name).toBe('business-rules-validation');
        expect(meta.version).toBe('1.0.0');
        expect(meta.capabilities).toEqual([
            'pr.metadata.read',
            'pr.diff.read',
            'task.context.read',
        ]);
        expect(meta.capabilityDefinitions).toEqual({
            'pr.metadata.read': {
                mode: 'fixed_tools',
                tools: ['KODUS_GET_PULL_REQUEST'],
            },
            'pr.diff.read': {
                mode: 'fixed_tools',
                tools: ['KODUS_GET_PULL_REQUEST_DIFF'],
            },
            'task.context.read': {
                mode: 'provider_dynamic',
            },
        });
        expect(meta.allowedTools).toEqual([
            'KODUS_GET_PULL_REQUEST',
            'KODUS_GET_PULL_REQUEST_DIFF',
        ]);
        expect(meta.fetcherPolicy).toEqual({
            toolMode: 'any',
            allowWithoutTools: false,
        });
        expect(meta.executionPolicy).toEqual({
            onMissingMcp: 'fail',
            onMcpConnectError: 'fail',
            fetcherTimeoutMs: 120000,
            analyzerTimeoutMs: 120000,
            fetcherMaxIterations: 2,
            analyzerMaxIterations: 1,
        });
        expect(meta.contracts).toEqual({
            input: {
                requiredContextFields: [
                    'organizationAndTeamData.organizationId',
                    'organizationAndTeamData.teamId',
                    'prepareContext.repository.id',
                ],
            },
            output: {
                requiredFields: ['needsMoreInfo', 'summary'],
            },
        });
        expect(meta.requiredMcps).toEqual([
            {
                category: 'task-management',
                label: 'Task Management',
                examples: 'Jira, Linear, Notion, ClickUp, Github Issues',
            },
        ]);
    });

    it('parses complex YAML frontmatter using a YAML parser', () => {
        const service = new SkillLoaderService() as any;

        const parsed = service.parseFrontmatter(`---
name: business-rules-validation
description: >
  Validate PR code changes against task requirements
  with multiline YAML support
allowed-tools: KODUS_GET_PULL_REQUEST_DIFF KODUS_GET_PULL_REQUEST
metadata:
  version: "2.0.0"
  kodus:
    fetcher-policy:
      tool-mode: all
      allow-without-tools: false
    required-mcps:
      - category: task-management
        label: "Task Management"
        examples: "Jira: Cloud, Linear"
    execution-policy:
      on-missing-mcp: fallback
      on-mcp-connect-error: fail
      fetcher-timeout-ms: 50000
    contracts:
      input:
        required-context-fields:
          - "prepareContext.pullRequest.pullRequestNumber"
      output:
        required-fields:
          - "summary"
---

# Body`);

        expect(parsed.meta.description).toBe(
            'Validate PR code changes against task requirements with multiline YAML support\n',
        );
        expect(parsed.meta.allowedTools).toEqual([
            'KODUS_GET_PULL_REQUEST_DIFF',
            'KODUS_GET_PULL_REQUEST',
        ]);
        expect(parsed.meta.fetcherPolicy).toEqual({
            toolMode: 'all',
            allowWithoutTools: false,
        });
        expect(parsed.meta.requiredMcps).toEqual([
            {
                category: 'task-management',
                label: 'Task Management',
                examples: 'Jira: Cloud, Linear',
            },
        ]);
        expect(parsed.meta.version).toBe('2.0.0');
        expect(parsed.meta.executionPolicy).toEqual({
            onMissingMcp: 'fallback',
            onMcpConnectError: 'fail',
            fetcherTimeoutMs: 50000,
            analyzerTimeoutMs: undefined,
            fetcherMaxIterations: undefined,
            analyzerMaxIterations: undefined,
        });
        expect(parsed.meta.contracts).toEqual({
            input: {
                requiredContextFields: [
                    'prepareContext.pullRequest.pullRequestNumber',
                ],
            },
            output: {
                requiredFields: ['summary'],
            },
        });
    });

    it('keeps backward compatibility with legacy Kodus top-level keys', () => {
        const service = new SkillLoaderService() as any;

        const parsed = service.parseFrontmatter(`---
name: legacy-skill
description: Legacy format
allowed-tools:
  - KODUS_GET_PULL_REQUEST_DIFF
capabilities:
  - pr.diff.read
fetcher-policy:
  tool-mode: any
contracts:
  output:
    required-fields:
      - summary
---

# Body`);

        expect(parsed.meta.allowedTools).toEqual([
            'KODUS_GET_PULL_REQUEST_DIFF',
        ]);
        expect(parsed.meta.capabilities).toEqual(['pr.diff.read']);
        expect(parsed.meta.fetcherPolicy).toEqual({
            toolMode: 'any',
            allowWithoutTools: undefined,
        });
        expect(parsed.meta.contracts).toEqual({
            input: undefined,
            output: {
                requiredFields: ['summary'],
            },
        });
    });

    it('normalizes capabilityToolMap from SKILL.md frontmatter', () => {
        const service = new SkillLoaderService() as any;

        const parsed = service.parseFrontmatter(`---
name: multi-tool-skill
description: Skill with capability-tool-map
metadata:
  kodus:
    capability-tool-map:
      task.context.read: getLinearIssue getNotionPage
      custom.read:
        - getCustomData
        - getOtherData
---

# Body`);

        expect(parsed.meta.capabilityToolMap).toEqual({
            'task.context.read': ['getLinearIssue', 'getNotionPage'],
            'custom.read': ['getCustomData', 'getOtherData'],
        });
    });

    it('returns undefined capabilityToolMap when not declared', () => {
        const service = new SkillLoaderService() as any;

        const parsed = service.parseFrontmatter(`---
name: basic-skill
description: No capability-tool-map
---

# Body`);

        expect(parsed.meta.capabilityToolMap).toBeUndefined();
    });

    it('normalizes capabilityDefinitions from SKILL.md frontmatter', () => {
        const service = new SkillLoaderService() as any;

        const parsed = service.parseFrontmatter(`---
name: dynamic-capability-skill
description: Skill with capability definitions
metadata:
  kodus:
    capability-definitions:
      task.context.read:
        mode: provider_dynamic
      custom.read:
        mode: fixed_tools
        tools: getCustomData getMoreData
      inferred.fixed:
        tools:
          - getA
          - getB
---

# Body`);

        expect(parsed.meta.capabilityDefinitions).toEqual({
            'task.context.read': { mode: 'provider_dynamic' },
            'custom.read': {
                mode: 'fixed_tools',
                tools: ['getCustomData', 'getMoreData'],
            },
            'inferred.fixed': {
                mode: 'fixed_tools',
                tools: ['getA', 'getB'],
            },
        });
    });

    it('warns and ignores invalid metadata.kodus schema', () => {
        const service = new SkillLoaderService() as any;
        const warnSpy = jest.spyOn((service as any).logger, 'warn');

        const parsed = service.parseFrontmatter(`---
name: invalid-kodus
description: Invalid kodus metadata
metadata:
  kodus:
    fetcher-policy: invalid
---

# Body`);

        expect(parsed.meta.fetcherPolicy).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('invalid metadata.kodus schema'),
        );
    });

    it('merges team overlay instructions when teamId is provided', () => {
        const service = new SkillLoaderService() as any;
        const overlayPath = '/tmp/skill-overlay-team-1.md';
        fs.writeFileSync(overlayPath, 'TEAM OVERLAY', 'utf-8');

        jest.spyOn(service, 'loadFromFilesystem').mockReturnValue('BASE');
        jest.spyOn(service, 'resolveSkillFilePath').mockImplementation(
            (_skillName: string, fileName: string) =>
                fileName === path.join('overrides', 'teams', 'team-1.md')
                    ? overlayPath
                    : null,
        );
        try {
            const result = service.loadInstructions(
                'business-rules-validation',
                {
                    teamId: 'team-1',
                },
            );

            expect(result).toContain('BASE');
            expect(result).toContain('## Custom Instructions');
            expect(result).toContain('TEAM OVERLAY');
        } finally {
            fs.unlinkSync(overlayPath);
        }
    });
});
