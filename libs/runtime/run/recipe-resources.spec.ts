import { resolveRecipeResources } from './recipe-resources';
const ceiling = { cpus: 8, memoryMb: 16384 };
describe('resolveRecipeResources before admission', () => {
    it('uses an explicit admin size over the recipe, then recipe over default', () => {
        const recipe = { cpus: 4, memoryMb: 8192 };
        expect(
            resolveRecipeResources({
                recipe,
                admin: { cpus: 2, memoryMb: 4096 },
                ceiling,
            }),
        ).toEqual({ ok: true, size: { cpus: 2, memoryMb: 4096 } });
        expect(resolveRecipeResources({ recipe, ceiling })).toEqual({
            ok: true,
            size: recipe,
        });
        expect(resolveRecipeResources({ ceiling })).toEqual({ ok: true });
    });
    it('never clamps an above-plan admin or recipe size', () => {
        for (const fields of [
            { recipe: { cpus: 16, memoryMb: 16384 } },
            { admin: { cpus: 2, memoryMb: 32768 } },
        ])
            expect(
                resolveRecipeResources({ ...fields, ceiling }),
            ).toMatchObject({ ok: false, reason: 'size_above_plan' });
    });
    it('blocks an explicit disk requirement even when an admin size overrides CPU/RAM', () => {
        expect(
            resolveRecipeResources({
                recipe: { cpus: 4, memoryMb: 8192, diskGb: 100 },
                admin: { cpus: 2, memoryMb: 4096 },
                ceiling,
            }),
        ).toMatchObject({ ok: false, reason: 'disk_unsupported' });
    });
});
