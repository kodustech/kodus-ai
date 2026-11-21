import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

// runtime-fleet ships the way runtime-hub and runtime-worker ship (docs/runtime/host-providers.md §4.1): a Nest
// project the build compiles, an image stage that runs it, a bake target, and a dev compose service with its own
// client certificate, whose CN the hub admits on the fleet routes only (FleetAuthGuard).

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('runtime-fleet is deployable', () => {
    it('nest builds it: a runtime-fleet project in the runtime tree whose entry is fleet/main', () => {
        const projects = JSON.parse(read('nest-cli.json')).projects;
        expect(projects['runtime-fleet']).toMatchObject({ type: 'application', root: 'apps/runtime', entryFile: 'fleet/main', sourceRoot: 'apps/runtime/src' });
        expect(projects['runtime-fleet'].compilerOptions.tsConfigPath).toBe('apps/runtime/tsconfig.json');
    });

    it('the image has a runtime-fleet stage on the control-plane base that runs the built entry, and the runtime bake group builds it', () => {
        const dockerfile = read('docker/Dockerfile');
        expect(dockerfile).toMatch(/^FROM runtime-control-plane AS runtime-fleet$/m);
        expect(dockerfile).toContain('CMD ["node", "dist/apps/runtime/fleet/main.js"]');
        const bake = read('docker-bake.hcl');
        expect(bake).toMatch(/target "runtime-fleet" \{[^}]*target = "runtime-fleet"/);
        expect(bake).toMatch(/group "runtime" \{\s*targets = \[[^\]]*"runtime-fleet"/);
    });

    it('the dev compose runs it under its own profile with the fleet certificate, and the hub admits that CN on the fleet routes', () => {
        const compose = yaml.load(read('docker-compose.dev.yml')) as { services: Record<string, any> };
        const fleet = compose.services['runtime-fleet'];
        expect(fleet.profiles).toEqual(['runtime-fleet']);
        expect(fleet.command).toContain('. /certs/fleet.env');
        expect(fleet.command).toContain('apps/runtime/src/fleet/main.ts');
        expect(fleet.environment.RUNTIME_FLEET_INSTALLATION).toBeDefined();
        expect(compose.services['runtime-hub'].environment.RUNTIME_FLEET_ALLOWED_CNS).toContain('runtime-fleet');
        const ca = read('scripts/runtime/dev-ca.sh');
        expect(ca).toMatch(/leaf fleet "\/O=kodus-runtime\/OU=worker\/CN=runtime-fleet"/);
        expect(ca).toMatch(/RUNTIME_WORKER_TLS_CERT=\/certs\/fleet\.pem/);
    });

    // Waits on the owner: package.json is theirs to change (build:runtime and build:apps gain
    // `nest build runtime-fleet`). Until then the image's runtime-fleet stage stops the build with that message.
    // When this test starts to pass, Jest fails it: turn `it.failing` into `it`.
    it.failing('the build scripts build it (package.json build:runtime and build:apps)', () => {
        const scripts = JSON.parse(read('package.json')).scripts;
        expect(scripts['build:runtime']).toContain('nest build runtime-fleet');
        expect(scripts['build:apps']).toContain('nest build runtime-fleet');
    });
});
