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
 * Shared RBAC matrix extraction + evaluation.
 *
 * The single source of truth for "what verdict (allow/deny) does each role get
 * on each gated controller endpoint". Statically extracts every endpoint's
 * declared @CheckPolicies (via the TS compiler) AND its HTTP method + URL path,
 * then evaluates the REAL verdict for each role using the REAL
 * PermissionsAbilityFactory + the REAL policy handlers.
 *
 * Two consumers:
 *   - authorization-matrix.spec.ts — snapshots the grid (static regression).
 *   - rbac-matrix.manifest.spec.ts — emits/diffs a JSON manifest that the
 *     full-stack e2e (tests/e2e) replays against a real running API. Keeping
 *     both off this one extractor means the static grid and the live e2e can
 *     never disagree about what the matrix says.
 */

export const CONTROLLERS_DIR = path.resolve(__dirname, '..');
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

export type HandlerSpec =
    | { kind: 'permissions'; action: string; resource: string }
    | { kind: 'repoPermissions'; action: string; resource: string }
    | { kind: 'role'; role: string }
    | {
          kind: 'anyPermission';
          pairs: Array<{ action: string; resource: string }>;
      }
    | { kind: 'unknown'; text: string };

export type Verdict = 'allow' | 'deny';

export interface Endpoint {
    key: string; // `<file>#<method>`
    httpMethod: string; // GET | POST | ...
    urlPath: string; // `/usage/tokens/summary`, params kept as `:id`
    specs: HandlerSpec[];
}

export interface ManifestEntry {
    key: string;
    httpMethod: string;
    urlPath: string;
    expected: Record<string, Verdict>; // role -> allow|deny
}

export const ROLES: Role[] = [
    Role.OWNER,
    Role.BILLING_MANAGER,
    Role.REPO_ADMIN,
    Role.CONTRIBUTOR,
];

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
            // String-literal values (e.g. @Controller({ path: 'usage' })) must
            // be unquoted; member-access values (Action.Read) keep their name.
            out[prop.name.getText(source)] = ts.isStringLiteralLike(
                prop.initializer,
            )
                ? prop.initializer.text
                : memberName(prop.initializer, source);
        }
    }
    return out;
}

function specFromCall(
    call: ts.CallExpression,
    source: ts.SourceFile,
): HandlerSpec {
    const name = call.expression.getText(source);
    const arg0 = call.arguments[0];

    if (
        name === 'checkPermissions' &&
        arg0 &&
        ts.isObjectLiteralExpression(arg0)
    ) {
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
    if (
        name === 'checkAnyPermission' &&
        arg0 &&
        ts.isArrayLiteralExpression(arg0)
    ) {
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

function localConstSpecs(source: ts.SourceFile): Map<string, HandlerSpec> {
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

function stringArg(call: ts.CallExpression, source: ts.SourceFile): string {
    const a = call.arguments[0];
    if (a && ts.isStringLiteral(a)) return a.text;
    // @Controller({ path: 'x' })
    if (a && ts.isObjectLiteralExpression(a)) {
        const o = parseObjectArg(a, source);
        return o.path ?? '';
    }
    return '';
}

function controllerBase(
    node: ts.ClassDeclaration,
    source: ts.SourceFile,
): string {
    for (const dec of ts.getDecorators(node) ?? []) {
        if (
            ts.isCallExpression(dec.expression) &&
            dec.expression.expression.getText(source) === 'Controller'
        ) {
            return stringArg(dec.expression, source);
        }
    }
    return '';
}

function joinPath(base: string, sub: string): string {
    const parts = [base, sub]
        .map((p) => p.replace(/^\/+|\/+$/g, ''))
        .filter(Boolean);
    return '/' + parts.join('/');
}

function collectEndpoints(file: string): Endpoint[] {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
    );
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
            const base = controllerBase(node, source);

            for (const member of node.members) {
                if (!ts.isMethodDeclaration(member)) continue;
                const decs = ts.getDecorators(member) ?? [];
                const httpDec = decs.find(
                    (d) =>
                        ts.isCallExpression(d.expression) &&
                        HTTP_DECORATORS.has(
                            d.expression.expression.getText(source),
                        ),
                );
                if (!httpDec || !ts.isCallExpression(httpDec.expression))
                    continue;

                const httpMethod = httpDec.expression.expression
                    .getText(source)
                    .toUpperCase();
                const sub = stringArg(httpDec.expression, source);

                const specs =
                    checkPoliciesSpecs(
                        ts.getDecorators(member),
                        source,
                        consts,
                    ) ?? classSpecs;
                if (!specs) continue; // ungated

                endpoints.push({
                    key: `${relFile}#${member.name.getText(source)}`,
                    httpMethod,
                    urlPath: joinPath(base, sub),
                    specs,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return endpoints;
}

export function collectAllEndpoints(): Endpoint[] {
    return listControllerFiles(CONTROLLERS_DIR).flatMap(collectEndpoints);
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
            return false;
    }
}

/**
 * Build the effective `endpoint -> { role: 'allow'|'deny' }` grid, evaluating
 * each endpoint's declared policy against the REAL factory + handlers.
 */
export async function buildMatrix(): Promise<
    Record<string, Record<string, Verdict>>
> {
    const factory = new PermissionsAbilityFactory({
        findOne: async () => ({
            permissions: { assignedRepositoryIds: [ASSIGNED_REPO] },
        }),
    } as any);

    const abilities = new Map<Role, any>();
    for (const role of ROLES) {
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

    const endpoints = collectAllEndpoints();
    const matrix: Record<string, Record<string, Verdict>> = {};
    for (const ep of endpoints) {
        const row: Record<string, Verdict> = {};
        for (const role of ROLES) {
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
}

/**
 * Manifest the live e2e replays: one entry per gated endpoint with its HTTP
 * method, URL path, and the expected verdict per role. Sorted for a stable
 * diff.
 */
export async function buildManifest(): Promise<ManifestEntry[]> {
    const endpoints = collectAllEndpoints();
    const matrix = await buildMatrix();
    return endpoints
        .map((ep) => ({
            key: ep.key,
            httpMethod: ep.httpMethod,
            urlPath: ep.urlPath,
            expected: matrix[ep.key],
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
}
