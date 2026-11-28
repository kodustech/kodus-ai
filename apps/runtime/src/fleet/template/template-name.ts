import { createHash } from 'crypto';

// The saved-snapshot name of an environment's template (docs/runtime/host-providers.md §8.2):
// kodus-env-<org-hash>-<env-hash>-<fingerprint>. boat names are at most 63 lowercase characters
// (^[a-z0-9][a-z0-9-]{0,62}$), and a provider's snapshot list should not carry an org's id, so org and
// environment go in as short hashes; the build fingerprint's first 16 hex characters name the build, and a short
// hash of the cell base it was built from ends it (55 characters in all).

const short = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 10);

export function templateNameOf(organizationId: string, environmentId: string, fingerprint: string, cellBase = ''): string {
    if (!/^[0-9a-f]{16,64}$/.test(fingerprint)) throw new Error('a template fingerprint is 16 to 64 lowercase hex characters');
    const name = `kodus-env-${short(organizationId)}-${short(`${organizationId}\n${environmentId}`)}-${fingerprint.slice(0, 16)}`;
    // The same build on a new cell base is another disk: its own name, so the old one is never overwritten while Run hosts start from it.
    return cellBase ? `${name}-${short(cellBase).slice(0, 6)}` : name;
}
