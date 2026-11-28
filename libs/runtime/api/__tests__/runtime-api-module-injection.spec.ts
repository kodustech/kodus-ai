import 'reflect-metadata';

import { RuntimeApiModule } from '../runtime-api.module';

// Nest resolves a constructor parameter by its @Inject token or, without one, by the type TypeScript emits. A parameter
// typed `Pick<X, …>`, an interface or a union emits `Object`, which Nest cannot resolve: the API and the worker then
// refuse to boot. Unit specs build these classes by hand and never see it, so this reads the module's own providers.

type Ctor = abstract new (...args: never[]) => unknown;

/** Nest's own key for the tokens of `@Inject` on constructor parameters. */
const SELF_DECLARED_DEPS = 'self:paramtypes';

function classProviders(): Ctor[] {
    const providers = (Reflect.getMetadata('providers', RuntimeApiModule) ?? []) as unknown[];
    const out: Ctor[] = [];
    for (const p of providers) {
        if (typeof p === 'function') out.push(p as Ctor);
        else if (p && typeof p === 'object' && 'useClass' in p && typeof (p as { useClass: unknown }).useClass === 'function') {
            out.push((p as { useClass: Ctor }).useClass);
        }
    }
    return out;
}

/** The parameters Nest could not resolve: no @Inject token and an emitted type that names no provider. */
function unresolvableParams(cls: Ctor): number[] {
    const types = (Reflect.getMetadata('design:paramtypes', cls) ?? []) as unknown[];
    const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS, cls) ?? []) as { index: number }[];
    const injected = new Set(declared.map((d) => d.index));
    return types.flatMap((t, i) => (injected.has(i) || (typeof t === 'function' && t !== Object) ? [] : [i]));
}

describe('the Runtime API module can build every class it provides', () => {
    it('reads the module providers', () => {
        expect(classProviders().length).toBeGreaterThan(10);
    });

    it('every constructor parameter has an @Inject token or a class type', () => {
        const broken = classProviders()
            .map((cls) => ({ name: cls.name, params: unresolvableParams(cls) }))
            .filter((b) => b.params.length > 0);
        expect(broken).toEqual([]);
    });
});
