import {
    fitsWithin,
    MachineSizeSchema,
    type MachineSize,
} from '@libs/runtime/contracts/machine-size';
import type { RecipeSize } from '@libs/runtime/protocol/recipe';

export type RecipeResourceResolution =
    | { ok: true; size?: MachineSize }
    | {
          ok: false;
          reason:
              | 'disk_unsupported'
              | 'size_above_plan'
              | 'size_invalid'
              | 'size_unreserved';
          message: string;
      };

/** Resolve before outbox/admission: a recipe asks, the admin and plan authorize. Never clamp. */
export function resolveRecipeResources(input: {
    recipe?: RecipeSize;
    admin?: MachineSize;
    ceiling: MachineSize;
}): RecipeResourceResolution {
    if (input.recipe?.diskGb !== undefined)
        return {
            ok: false,
            reason: 'disk_unsupported',
            message:
                'The recipe requires disk enforcement, which is not supported by this Runtime path; no machine was started.',
        };
    const size =
        input.admin ??
        (input.recipe?.cpus !== undefined && input.recipe.memoryMb !== undefined
            ? { cpus: input.recipe.cpus, memoryMb: input.recipe.memoryMb }
            : undefined);
    if (!size) return { ok: true };
    if (!MachineSizeSchema.safeParse(size).success)
        return {
            ok: false,
            reason: 'size_invalid',
            message:
                'The effective recipe machine size is invalid; no machine was started.',
        };
    if (!fitsWithin(size, input.ceiling))
        return {
            ok: false,
            reason: 'size_above_plan',
            message:
                'The effective recipe machine size exceeds the plan ceiling; choose a smaller size or raise the plan ceiling. No machine was started.',
        };
    return { ok: true, size: { ...size } };
}

/** A worker cannot enlarge a claim after admission; only an already-reserved admin/recipe size may run. */
export function checkReservedRecipeResources(
    recipe: RecipeSize | undefined,
    reserved: MachineSize | undefined,
): RecipeResourceResolution {
    if (recipe?.diskGb !== undefined)
        return {
            ok: false,
            reason: 'disk_unsupported',
            message:
                'The recipe requires disk enforcement, which is not supported by this Runtime path; no machine was started.',
        };
    if (recipe?.cpus !== undefined && !reserved)
        return {
            ok: false,
            reason: 'size_unreserved',
            message:
                'The recipe machine size was not reserved before admission; request a new setup with an updated product.',
        };
    return { ok: true, ...(reserved ? { size: reserved } : {}) };
}
