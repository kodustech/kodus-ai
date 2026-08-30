/**
 * Every Kodus MCP tool must declare what it does to state.
 *
 * Consumers derive behavior from these annotations instead of keeping their own
 * name lists: the conversation agent audits anything that is not `readOnlyHint`,
 * refuses to proactively offer anything `destructiveHint`, and offers exactly
 * the tools carrying a `proactiveHint`. An un-annotated tool would silently drop
 * out of that wiring, so the declaration is enforced here rather than trusted.
 */
import { CodeManagementTools } from './codeManagement.tools';
import { KodyIssuesTools } from './kodyIssues.tools';
import { KodyRulesTools } from './kodyRules.tools';
import { KodusIssuesTools } from './kodusIssues.tools';

// The tool builders only close over their services (used inside `execute`), so
// definitions can be listed without a container.
const stub = () => ({}) as never;

const ALL_TOOLS = [
    ...new KodyRulesTools(stub(), stub(), stub()).getAllTools(),
    ...new KodyIssuesTools(stub(), stub()).getAllTools(),
    ...new CodeManagementTools(stub()).getAllTools(),
    ...new KodusIssuesTools(stub()).getAllTools(),
];

const named = (name: string) => ALL_TOOLS.find((t) => t.name === name);

describe('Kodus MCP tool annotations', () => {
    it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
        '%s declares readOnlyHint',
        (_name, tool) => {
            expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
        },
    );

    it('marks the mutating tools as writes', () => {
        for (const name of [
            'KODUS_CREATE_MEMORY',
            'KODUS_CREATE_KODY_RULE',
            'KODUS_UPDATE_KODY_RULE',
            'KODUS_DELETE_KODY_RULE',
            'KODUS_CREATE_KODY_ISSUE',
            'KODUS_UPDATE_KODY_ISSUE_STATUS',
            'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
            'KODUS_DELETE_KODY_ISSUE',
        ]) {
            expect(named(name)?.annotations?.readOnlyHint).toBe(false);
        }
    });

    it('marks the irreversible tools as destructive', () => {
        expect(named('KODUS_DELETE_KODY_RULE')?.annotations?.destructiveHint).toBe(
            true,
        );
        expect(named('KODUS_DELETE_KODY_ISSUE')?.annotations?.destructiveHint).toBe(
            true,
        );
    });

    it('never offers a destructive tool proactively', () => {
        const offerable = ALL_TOOLS.filter((t) => t.annotations?.proactiveHint);

        expect(offerable.length).toBeGreaterThan(0);
        for (const tool of offerable) {
            expect(tool.annotations?.readOnlyHint).toBe(false);
            expect(tool.annotations?.destructiveHint).not.toBe(true);
            expect(typeof tool.annotations?.proactiveHint).toBe('string');
        }
    });
});
