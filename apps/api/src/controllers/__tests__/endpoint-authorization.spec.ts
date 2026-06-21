import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Guard-rail: every HTTP handler in a controller MUST be authorized in one of
 * three explicit ways:
 *   1. `@Public()` — intentionally unauthenticated (or auth handled elsewhere,
 *      e.g. CLI-key / webhook-signature).
 *   2. `@CheckPolicies(...)` — RBAC-gated (handler-level or class-level).
 *   3. listed in INTENTIONALLY_UNGATED below — authenticated but not
 *      permission-gated on purpose (e.g. per-user data scoped by `req.user`).
 *
 * Anything else fails the test. This is the net that would have caught the
 * ungated `DELETE /delete-byok-config` and the wide-open `tokenUsage`
 * controller. Adding a new ungated endpoint forces a conscious decision here.
 */

const CONTROLLERS_DIR = path.resolve(__dirname, '..');

const HTTP_METHOD_DECORATORS = new Set([
    'Get',
    'Post',
    'Put',
    'Patch',
    'Delete',
    'All',
    'Head',
    'Options',
    'Sse',
]);

const GATE_DECORATORS = new Set(['CheckPolicies', 'Public']);

/**
 * Authenticated endpoints that are intentionally NOT permission-gated.
 * Keyed by `<controller-file>#<methodName>`. Each entry must have a reason.
 */
const INTENTIONALLY_UNGATED = new Set<string>([
    // --- Caller's own data (scoped by req.user, no cross-tenant exposure) ---
    'permissions.controller.ts#getPermissions', // returns the caller's own permission map
    'permissions.controller.ts#can', // checks the caller's own permission
    'permissions.controller.ts#getAssignedRepos', // caller's own assigned repos
    'user.controller.ts#show', // caller's own profile
    'user.controller.ts#saveMarketingSurvey', // caller's own marketing survey
    'auth.controller.ts#logout', // self logout
    'auth.controller.ts#getHelpdeskToken', // helpdesk token for the caller
    'cli-auth.controller.ts#complete', // device-auth completion for the logged-in user
    'agent.controller.ts#conversation', // per-user agent conversation
    'ruleLike.controller.ts#setFeedback', // caller's own rule feedback
    'ruleLike.controller.ts#removeFeedback', // caller's own rule feedback
    'notification.controller.ts#list', // per-user notification bell
    'notification.controller.ts#unreadCount', // per-user
    'notification.controller.ts#stream', // per-user SSE
    'notification.controller.ts#markAsRead', // per-user
    'notification.controller.ts#markAllAsRead', // per-user
    'notification.controller.ts#seedFakeNotifications', // dev-only (NODE_ENV guard)

    // --- Static catalog / low-sensitivity metadata for the caller's own org ---
    'notification.controller.ts#getNotificationConfig', // static notification catalog for the UI
    'organizationParameters.controller.ts#listProviders', // static LLM provider catalog
    'organizationParameters.controller.ts#listModels', // static LLM model catalog
    'organization.controller.ts#getOrganizationName', // org name for caller's org
    'organization.controller.ts#getOrganizationLanguage', // org language for caller's org
    'organization.controller.ts#getReleaseTrack', // release-track flag for caller's org
    'kodyRules.controller.ts#findLibraryKodyRulesWithFeedback', // kody-rules library is all-roles
    'license.controller.ts#orgStatus', // org license status; sibling /status is owner-gated
    'license.controller.ts#requestTrialExtension', // any trial org member can ask for more trial reviews (low-stakes; forwards to Discord)
    'team.controller.ts#list', // list of org teams (read)
    'team.controller.ts#listWithIntegrations', // list of org teams with integrations (read)

    // --- Borderline: reads, allowlisted for now; revisit in the RBAC consolidation ---
    // TODO(rbac): confirm these stay ungated or get a read gate in PR2.
    'codeManagement.controller.ts#getWebhookStatus', // webhook connectivity status
    'organization.controller.ts#getOrganizationsByDomain', // domain→org lookup (onboarding/SSO discovery)

    // --- Cron-triggered service endpoint (no end-user caller) ---
    // weekly-recap sends the recap email to ACTIVE org owners; it is invoked by
    // a scheduled cron with a service identity, not reachable through the UI.
    'cockpit.controller.ts#send',
]);

type Handler = {
    file: string;
    method: string;
    httpDecorators: string[];
    key: string;
};

function listControllerFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__') continue;
            out.push(...listControllerFiles(full));
        } else if (
            entry.name.endsWith('.controller.ts') &&
            !entry.name.endsWith('.spec.ts')
        ) {
            out.push(full);
        }
    }
    return out;
}

function decoratorNames(
    node: ts.HasDecorators,
    source: ts.SourceFile,
): string[] {
    const decorators = ts.getDecorators(node) ?? [];
    return decorators.map((d) => {
        let expr: ts.Expression = d.expression;
        if (ts.isCallExpression(expr)) {
            expr = expr.expression;
        }
        return expr.getText(source);
    });
}

function collectUngatedHandlers(file: string): Handler[] {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
    );
    const relFile = path.basename(file);
    const ungated: Handler[] = [];

    const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node)) {
            const classGates = decoratorNames(node, source).filter((n) =>
                GATE_DECORATORS.has(n),
            );
            const classIsGated = classGates.length > 0;

            for (const member of node.members) {
                if (!ts.isMethodDeclaration(member)) continue;
                const names = decoratorNames(member, source);
                const httpDecorators = names.filter((n) =>
                    HTTP_METHOD_DECORATORS.has(n),
                );
                if (httpDecorators.length === 0) continue; // not an HTTP handler

                const handlerIsGated = names.some((n) =>
                    GATE_DECORATORS.has(n),
                );
                if (handlerIsGated || classIsGated) continue;

                const methodName = member.name.getText(source);
                ungated.push({
                    file: relFile,
                    method: methodName,
                    httpDecorators,
                    key: `${relFile}#${methodName}`,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return ungated;
}

describe('controller endpoint authorization', () => {
    const files = listControllerFiles(CONTROLLERS_DIR);

    it('discovers controller files to scan', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it('every HTTP handler is @Public, @CheckPolicies, or explicitly allowlisted', () => {
        const allUngated = files.flatMap(collectUngatedHandlers);
        const offenders = allUngated.filter(
            (h) => !INTENTIONALLY_UNGATED.has(h.key),
        );

        if (offenders.length > 0) {
            const lines = offenders
                .map(
                    (h) =>
                        `  - ${h.key} (@${h.httpDecorators.join(', @')})`,
                )
                .sort()
                .join('\n');
            throw new Error(
                `Found ${offenders.length} controller endpoint(s) without @Public, @CheckPolicies, or an INTENTIONALLY_UNGATED entry:\n${lines}\n\n` +
                    `Gate each endpoint with @CheckPolicies, mark it @Public, or add it to INTENTIONALLY_UNGATED with a justification.`,
            );
        }
    });
});
