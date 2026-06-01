import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    Action,
    ResourceType,
    Role,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import {
    checkAnyPermission,
    checkPermissions,
    checkRepoPermissions,
    checkRole,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

/**
 * Effective authorization matrix — the flagship RBAC regression gate.
 *
 * For EVERY gated controller endpoint, this statically extracts the policy it
 * declares (@CheckPolicies(checkPermissions/checkRepoPermissions/checkRole/...))
 * and evaluates the REAL verdict for each role using the REAL
 * PermissionsAbilityFactory + the REAL policy handlers — then snapshots the
 * whole `endpoint × role → allow/deny` grid.
 *
 * Why this and not HTTP integration tests: the heavy controllers can't be
 * mounted in isolation (circular module graph), but their authorization is
 * fully determined by (declared policy) × (factory output) × (handler logic) —
 * all of which we exercise here without importing the controllers. Any change
 * to ROLE_POLICIES, a controller's decorator, or the factory shifts the
 * snapshot, so the reviewer sees exactly which cells changed.
 */

const CONTROLLERS_DIR = path.resolve(__dirname, '..');
const ASSIGNED_REPO = 'repo-assigned';

const HTTP_DECORATORS = new Set([
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

type HandlerSpec =
    | { kind: 'permissions'; action: string; resource: string }
    | { kind: 'repoPermissions'; action: string; resource: string }
    | { kind: 'role'; role: string }
    | {
          kind: 'anyPermission';
          pairs: Array<{ action: string; resource: string }>;
      }
    | { kind: 'unknown'; text: string };

type Endpoint = {
    key: string; // `<file>#<method>`
    specs: HandlerSpec[];
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

// Resolve `Action.Read` / `ResourceType.Foo` member-access into the runtime
// value, returning the member name (we only need it for the snapshot label).
function memberName(node: ts.Node, source: ts.SourceFile): string {
    if (ts.isPropertyAccessExpression(node)) return node.name.getText(source);
    return node.getText(source);
}

function parseObjectArg(
    obj: ts.ObjectLiteralExpression,
    source: ts.SourceFile,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop)) {
            out[prop.name.getText(source)] = memberName(
                prop.initializer,
                source,
            );
        }
    }
    return out;
}

function specFromCall(call: ts.CallExpression, source: ts.SourceFile): HandlerSpec {
    const name = call.expression.getText(source);
    const arg0 = call.arguments[0];

    if (name === 'checkPermissions' && arg0 && ts.isObjectLiteralExpression(arg0)) {
        const o = parseObjectArg(arg0, source);
        return { kind: 'permissions', action: o.action, resource: o.resource };
    }
    if (
        name === 'checkRepoPermissions' &&
        arg0 &&
        ts.isObjectLiteralExpression(arg0)
    ) {
        const o = parseObjectArg(arg0, source);
        return {
            kind: 'repoPermissions',
            action: o.action,
            resource: o.resource,
        };
    }
    if (name === 'checkRole' && arg0 && ts.isObjectLiteralExpression(arg0)) {
        const o = parseObjectArg(arg0, source);
        return { kind: 'role', role: o.role };
    }
    if (name === 'checkAnyPermission' && arg0 && ts.isArrayLiteralExpression(arg0)) {
        const pairs = arg0.elements
            .filter(ts.isObjectLiteralExpression)
            .map((el) => {
                const o = parseObjectArg(el, source);
                return { action: o.action, resource: o.resource };
            });
        return { kind: 'anyPermission', pairs };
    }
    return { kind: 'unknown', text: call.getText(source).slice(0, 60) };
}

// Map local `const X = checkPermissions({...})` so identifier args resolve.
function localConstSpecs(
    source: ts.SourceFile,
): Map<string, HandlerSpec> {
    const map = new Map<string, HandlerSpec>();
    const visit = (node: ts.Node) => {
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.name)
        ) {
            map.set(node.name.text, specFromCall(node.initializer, source));
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return map;
}

function checkPoliciesSpecs(
    decorators: readonly ts.Decorator[] | undefined,
    source: ts.SourceFile,
    consts: Map<string, HandlerSpec>,
): HandlerSpec[] | null {
    if (!decorators) return null;
    for (const dec of decorators) {
        if (!ts.isCallExpression(dec.expression)) continue;
        if (dec.expression.expression.getText(source) !== 'CheckPolicies')
            continue;
        return dec.expression.arguments.map((arg) => {
            if (ts.isCallExpression(arg)) return specFromCall(arg, source);
            if (ts.isIdentifier(arg))
                return (
                    consts.get(arg.text) ?? {
                        kind: 'unknown',
                        text: arg.text,
                    }
                );
            return { kind: 'unknown', text: arg.getText(source).slice(0, 60) };
        });
    }
    return null;
}

function collectEndpoints(file: string): Endpoint[] {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const consts = localConstSpecs(source);
    const relFile = path.basename(file);
    const endpoints: Endpoint[] = [];

    const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node)) {
            const classSpecs = checkPoliciesSpecs(
                ts.getDecorators(node),
                source,
                consts,
            );
            for (const member of node.members) {
                if (!ts.isMethodDeclaration(member)) continue;
                const decs = ts.getDecorators(member) ?? [];
                const isHttp = decs.some(
                    (d) =>
                        ts.isCallExpression(d.expression) &&
                        HTTP_DECORATORS.has(
                            d.expression.expression.getText(source),
                        ),
                );
                if (!isHttp) continue;

                // method-level @CheckPolicies overrides class-level
                const specs =
                    checkPoliciesSpecs(ts.getDecorators(member), source, consts) ??
                    classSpecs;
                if (!specs) continue; // ungated (covered by endpoint-authorization.spec)

                endpoints.push({
                    key: `${relFile}#${member.name.getText(source)}`,
                    specs,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return endpoints;
}

const fakeReq = (role: Role) => ({
    user: {
        uuid: `user-${role}`,
        role,
        status: STATUS.ACTIVE,
        organization: { uuid: 'org-1' },
    },
    params: {},
    query: {},
    body: {},
});

async function evaluate(
    spec: HandlerSpec,
    ability: any,
    role: Role,
): Promise<boolean> {
    const req = fakeReq(role);
    switch (spec.kind) {
        case 'permissions':
            return checkPermissions({
                action: (Action as any)[spec.action],
                resource: (ResourceType as any)[spec.resource],
            })(ability, req as any) as boolean;
        case 'repoPermissions':
            return checkRepoPermissions({
                action: (Action as any)[spec.action],
                resource: (ResourceType as any)[spec.resource],
                repo: { custom: ASSIGNED_REPO },
            })(ability, req as any) as boolean;
        case 'role':
            return checkRole({ role: (Role as any)[spec.role] })(
                ability,
                req as any,
            ) as boolean;
        case 'anyPermission':
            return checkAnyPermission(
                spec.pairs.map((p) => ({
                    action: (Action as any)[p.action],
                    resource: (ResourceType as any)[p.resource],
                })),
            )(ability, req as any) as boolean;
        default:
            // Unknown handler shape — surface it instead of silently passing.
            return false;
    }
}

describe('authorization matrix (effective policy × role)', () => {
    const factory = new PermissionsAbilityFactory({
        findOne: async () => ({
            permissions: { assignedRepositoryIds: [ASSIGNED_REPO] },
        }),
    } as any);

    const roles = [
        Role.OWNER,
        Role.BILLING_MANAGER,
        Role.REPO_ADMIN,
        Role.CONTRIBUTOR,
    ];

    // Builds the effective `endpoint -> { role: 'allow'|'deny' }` grid by
    // evaluating each endpoint's declared policy against the REAL factory +
    // REAL policy handlers, for every role.
    const buildMatrix = async (): Promise<
        Record<string, Record<string, string>>
    > => {
        const abilities = new Map<Role, any>();
        for (const role of roles) {
            abilities.set(
                role,
                await factory.createForUser(
                    {
                        uuid: `u-${role}`,
                        role,
                        organization: { uuid: 'org-1' },
                    } as unknown as IUser,
                    [ASSIGNED_REPO],
                ),
            );
        }

        const endpoints = listControllerFiles(CONTROLLERS_DIR).flatMap(
            collectEndpoints,
        );
        // Guard against a parser regression silently emptying the matrix.
        expect(endpoints.length).toBeGreaterThan(30);

        const matrix: Record<string, Record<string, string>> = {};
        for (const ep of endpoints) {
            const row: Record<string, string> = {};
            for (const role of roles) {
                const ability = abilities.get(role);
                let allow = true; // AND across multiple @CheckPolicies handlers
                for (const spec of ep.specs) {
                    if (!(await evaluate(spec, ability, role))) {
                        allow = false;
                        break;
                    }
                }
                row[role] = allow ? 'allow' : 'deny';
            }
            matrix[ep.key] = row;
        }
        return matrix;
    };

    // Expected verdict for every gated endpoint of a controller, asserted
    // across ALL of that controller's gated endpoints (robust to method
    // renames; a new endpoint with the wrong gate fails here).
    const expectController = (
        matrix: Record<string, Record<string, string>>,
        filePrefix: string,
        expected: Record<string, string>,
    ) => {
        const rows = Object.fromEntries(
            Object.entries(matrix).filter(([k]) => k.startsWith(filePrefix)),
        );
        expect(Object.keys(rows).length).toBeGreaterThan(0);
        const expectedRows = Object.fromEntries(
            Object.keys(rows).map((k) => [k, expected]),
        );
        expect(rows).toEqual(expectedRows);
    };

    const ALLOW_OWNER = {
        owner: 'allow',
        billing_manager: 'deny',
        repo_admin: 'deny',
        contributor: 'deny',
    };

    it('enforces the expected verdicts for the key RBAC resources', async () => {
        const matrix = await buildMatrix();

        // Bug A: BYOK delete is Owner-only (was reachable by anyone).
        expect(
            matrix['organizationParameters.controller.ts#deleteByokConfig'],
        ).toEqual(ALLOW_OWNER);

        // Bug B: Token usage — Owner/Billing/RepoAdmin read, Contributor denied.
        expectController(matrix, 'tokenUsage.controller.ts#', {
            owner: 'allow',
            billing_manager: 'allow',
            repo_admin: 'allow',
            contributor: 'deny',
        });

        // Cockpit analytics — Owner + RepoAdmin only (was tier-only).
        expectController(matrix, 'cockpit.controller.ts#', {
            owner: 'allow',
            billing_manager: 'deny',
            repo_admin: 'allow',
            contributor: 'deny',
        });

        // CLI reviews — Owner/RepoAdmin/Contributor; Billing denied.
        expectController(matrix, 'cli-reviews.controller.ts#', {
            owner: 'allow',
            billing_manager: 'deny',
            repo_admin: 'allow',
            contributor: 'allow',
        });

        // SSO config — Owner-only.
        expectController(matrix, 'ssoConfig.controller.ts#', ALLOW_OWNER);
    });

    it('every gated endpoint resolved to a known handler shape', () => {
        const unknown = listControllerFiles(CONTROLLERS_DIR)
            .flatMap(collectEndpoints)
            .flatMap((ep) =>
                ep.specs
                    .filter((s) => s.kind === 'unknown')
                    .map((s) => `${ep.key}: ${(s as any).text}`),
            );
        expect(unknown).toEqual([]);
    });
});
