import type { SetupScope } from './setup-scope';

/**
 * What ends a setup before its commit is read: a command the product refused
 * for its resources or its recipe policy (a development ref override never
 * overrides either), or a setup the admission refused. True when the setup
 * ended blocked on it.
 */
export async function refusedBeforeBoot(setup: SetupScope): Promise<boolean> {
    const { cmd, execution, journal } = setup;
    if (cmd.blocker && (cmd.blocker.kind === 'resources' || cmd.blocker.kind === 'recipe_invalid')) {
        await journal.block(undefined, { kind: cmd.blocker.kind, signature: `setup:${cmd.blocker.kind}`, message: cmd.blocker.message });
        return true;
    }
    if (execution.admissionBlocker) {
        await journal.block(
            undefined,
            cmd.blocker
                ? {
                      kind: cmd.blocker.kind,
                      signature: `setup:${cmd.blocker.kind}`,
                      message: cmd.blocker.message,
                  }
                : execution.admissionBlocker,
        );
        return true;
    }
    return false;
}

/**
 * The commit (the `resolve_ref` step): the product's default-branch head, or
 * the explicit dev override. Undefined when the setup ended blocked on the
 * command's blocker or on a command with no commit.
 */
export async function resolveRef(setup: SetupScope): Promise<string | undefined> {
    const { cmd, rec, journal } = setup;
    const devSha = setup.deps.opts.devSha;
    const resolve = await journal.start('resolve_ref');
    if (devSha) {
        rec.refSource = 'dev_override';
        await journal.done(resolve, `dev override RUNTIME_SETUP_DEV_SHA ${devSha.slice(0, 12)}`);
        return devSha;
    }
    if (cmd.blocker) {
        await journal.block(resolve, { kind: cmd.blocker.kind, signature: `setup:${cmd.blocker.kind}`, message: cmd.blocker.message });
        return undefined;
    }
    if (!cmd.ref?.sha) {
        await journal.block(resolve, { kind: 'no_ref', signature: 'setup:no_ref', message: 'The setup request carries no commit to build.' });
        return undefined;
    }
    const sha = cmd.ref.sha;
    rec.refSource = 'default_branch';
    if (cmd.buildInputsDigest) rec.buildInputsDigest = cmd.buildInputsDigest;
    if (cmd.ref.branch) rec.branch = cmd.ref.branch;
    // Every other repository of the environment at its own default-branch head (the product read each one).
    const others = (cmd.workspace ?? []).filter((r) => r.role !== 'primary').map((r) => `; ${r.alias} ${r.branch} ${r.sha.slice(0, 12)}`);
    await journal.done(resolve, `${cmd.ref.branch ?? 'default branch'} ${sha.slice(0, 12)}${others.join('')}`);
    return sha;
}
