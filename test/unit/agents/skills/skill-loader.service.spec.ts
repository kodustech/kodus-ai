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

    it('loads skill metadata from SKILL.md frontmatter', () => {
        const service = new SkillLoaderService();

        const meta = service.loadSkillMetaFromFilesystem(
            'business-rules-validation',
        );

        expect(meta.name).toBe('business-rules-validation');
        expect(meta.version).toBe('1.0.0');
        // The runtime reads only these; nothing else is declared.
        expect(meta.executionPolicy).toEqual({
            analyzerTimeoutMs: 120000,
            analyzerMaxIterations: 1,
        });
        expect(meta.requiredMcps).toBeUndefined();
        expect(meta.capabilities).toBeUndefined();
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
