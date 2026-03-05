export function buildBusinessRulesContractViolationFeedback(
    _userLanguage: string,
    phase: 'input' | 'output',
    missingFields: string[] | undefined,
): string {
    const fields =
        missingFields && missingFields.length > 0
            ? missingFields.join(', ')
            : 'unknown';

    if (phase === 'input') {
        return `## ⚠️ Missing Validation Context

I couldn't start the skill because required context fields are missing: \`${fields}\`.

### How to fix
- Ensure the event includes organization, team, repository, and pull request number.
- Run again: \`@kody -v business-logic\``;
    }

    return `## ⚠️ Invalid Skill Response

The analysis step returned an incomplete response and failed output contract validation.

Missing fields: \`${fields}\`.

Please try again in a moment.`;
}
