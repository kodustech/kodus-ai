import { parseSkillMarkdown, SKILL_LIMITS } from './skill-validator';

const skill = (frontmatter: string, body = '# Rules\n\nUse typed errors.') =>
    `---\n${frontmatter}\n---\n${body}`;

describe('parseSkillMarkdown', () => {
    it('accepts a skill whose name matches its folder', () => {
        const result = parseSkillMarkdown(
            skill(
                'name: invoice-errors\ndescription: How the billing team raises invoice errors.',
            ),
            { expectedName: 'invoice-errors' },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.skill.name).toBe('invoice-errors');
        expect(result.skill.description).toBe(
            'How the billing team raises invoice errors.',
        );
        expect(result.skill.body).toBe('# Rules\n\nUse typed errors.');
        expect(result.skill.bodyTruncated).toBe(false);
        expect(result.notes).toEqual([]);
    });

    it.each([
        ['uppercase', 'Invoice-errors'],
        ['leading hyphen', '-invoice'],
        ['trailing hyphen', 'invoice-'],
        ['double hyphen', 'invoice--errors'],
        ['underscore', 'invoice_errors'],
        ['empty', '""'],
        ['too long', 'a'.repeat(SKILL_LIMITS.nameMaxLength + 1)],
    ])('rejects a %s name', (_label, name) => {
        const result = parseSkillMarkdown(
            skill(`name: ${name}\ndescription: Something.`),
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toMatch(/name/);
    });

    it('accepts a 64 character name', () => {
        const name = 'a'.repeat(SKILL_LIMITS.nameMaxLength);
        const result = parseSkillMarkdown(
            skill(`name: ${name}\ndescription: Something.`),
        );

        expect(result.ok).toBe(true);
    });

    it('rejects a name that differs from the folder', () => {
        const result = parseSkillMarkdown(
            skill('name: invoice-errors\ndescription: Something.'),
            { expectedName: 'ledger-errors' },
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toMatch(/ledger-errors/);
    });

    it('requires a description of at most 1024 characters', () => {
        const missing = parseSkillMarkdown(skill('name: invoice-errors'));
        const blank = parseSkillMarkdown(
            skill('name: invoice-errors\ndescription: "   "'),
        );
        const tooLong = parseSkillMarkdown(
            skill(
                `name: invoice-errors\ndescription: ${'d'.repeat(SKILL_LIMITS.descriptionMaxLength + 1)}`,
            ),
        );

        expect(missing.ok).toBe(false);
        expect(blank.ok).toBe(false);
        expect(tooLong.ok).toBe(false);
    });

    it('rejects a file without frontmatter or with broken YAML', () => {
        expect(parseSkillMarkdown('# Just a heading').ok).toBe(false);
        expect(parseSkillMarkdown('---\nname: [unclosed\n---\nbody').ok).toBe(
            false,
        );
        expect(parseSkillMarkdown('---\nname: invoice-errors\n').ok).toBe(
            false,
        );
    });

    it('does not execute YAML tags', () => {
        const result = parseSkillMarkdown(
            skill('name: !!js/function "function () {}"\ndescription: x'),
        );

        expect(result.ok).toBe(false);
    });

    it('truncates a body longer than 500 lines and flags it', () => {
        const body = Array.from(
            { length: SKILL_LIMITS.bodyMaxLines + 50 },
            (_, i) => `line ${i}`,
        ).join('\n');
        const result = parseSkillMarkdown(
            skill('name: invoice-errors\ndescription: Something.', body),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.skill.bodyTruncated).toBe(true);
        expect(result.skill.body).toContain('line 499');
        expect(result.skill.body).not.toContain('line 500\n');
        expect(result.skill.body).toMatch(/truncated/);
        expect(result.notes.join(' ')).toMatch(/truncated/);
    });

    it('truncates a body over the token budget even under 500 lines', () => {
        const body = Array.from(
            { length: 100 },
            (_, i) => `${i} ${'lorem ipsum dolor sit amet '.repeat(30)}`,
        ).join('\n');
        const result = parseSkillMarkdown(
            skill('name: invoice-errors\ndescription: Something.', body),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.skill.bodyTruncated).toBe(true);
        expect(result.skill.body.length).toBeLessThan(body.length);
    });

    it('surfaces compatibility as a note and ignores allowed-tools', () => {
        const result = parseSkillMarkdown(
            skill(
                'name: invoice-errors\ndescription: Something.\ncompatibility: Needs the internal ledger CLI\nallowed-tools: Bash(rm:*)',
            ),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.skill.compatibility).toBe(
            'Needs the internal ledger CLI',
        );
        expect(result.notes.join(' ')).toMatch(/compatibility/i);
        expect(result.skill).not.toHaveProperty('allowedTools');
    });

    it('accepts CRLF line endings', () => {
        const result = parseSkillMarkdown(
            '---\r\nname: invoice-errors\r\ndescription: Something.\r\n---\r\nBody',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.skill.body).toBe('Body');
    });
});
