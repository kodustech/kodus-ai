import { randomUUID } from 'crypto';

import { type RuntimeRunRequested, sealSecret } from '@libs/runtime/run';

import { SHOP_IMAGE } from '../fake-cell/scenarios';
import { devSealKey } from '../testing/dev-seal-key';

// A synthetic PR on the toy shop: the empty-cart check of POST /orders is
// dropped, and GET /orders is touched by the same diff.

const CONTROLLER = [
    "@Controller('orders')",
    'export class OrdersController {',
    '    @Get()',
    '    list() {',
    '        return this.orders.list();',
    '    }',
    '    @Post()',
    '    create(@Body() body: CreateOrder) {',
    '        return this.orders.create(body);',
    '    }',
    '}',
].join('\n');

const PATCH = [
    '@@ -4,7 +4,7 @@',
    '     list() {',
    '-        return this.orders.all();',
    '+        return this.orders.list();',
    '     }',
    '     @Post()',
    '     create(@Body() body: CreateOrder) {',
    '-        if (!body.items.length) throw new BadRequestException("cart is empty");',
    '+        return this.orders.create(body);',
].join('\n');

/** The fixture's tokens are sealed for the Run, as the product sends them (sealKey: the worker's key). */
export function shopRunRequest(overrides: Partial<RuntimeRunRequested> = {}, sealKey: Buffer = devSealKey()): RuntimeRunRequested {
    const runId = overrides.runId ?? randomUUID();
    return {
        runId,
        attempt: 1,
        correlationId: randomUUID(),
        requestedAt: new Date().toISOString(),
        organizationId: 'org-demo',
        teamId: 'team-demo',
        repository: { id: 'repo-shop', name: 'shop', fullName: 'demo/shop' },
        pullRequest: { number: 42, headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), fork: false },
        environment: { environmentId: 'shop', imageId: SHOP_IMAGE, expose: [{ service: 'web', port: 3000, kind: 'http' }] },
        diff: [{ path: 'src/orders/orders.controller.ts', patch: PATCH, content: CONTROLLER }],
        repoToken: sealSecret('fake-download-token', sealKey, runId),
        runToken: sealSecret('fake-run-token', sealKey, runId),
        trigger: 'pull_request',
        ...overrides,
    };
}
