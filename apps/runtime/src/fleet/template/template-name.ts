import { createHash } from 'crypto';

// The saved-snapshot name of an environment's template (docs/runtime/host-providers.md §8.2):
// kodus-env-<org-hash>-<env-hash>-<fingerprint>. boat names are at most 63 lowercase characters
// (^[a-z0-9][a-z0-9-]{0,62}$), and a provider's snapshot list should not carry an org's id, so org and
// environment go in as short hashes; the build fingerprint's first 16 hex characters name the build.

const short = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 10);

export function templateNameOf(organizationId: string, environmentId: string, fingerprint: string): string {
    if (!/^[0-9a-f]{16,64}$/.test(fingerprint)) throw new Error('a template fingerprint is 16 to 64 lowercase hex characters');
    return `kodus-env-${short(organizationId)}-${short(`${organizationId}\n${environmentId}`)}-${fingerprint.slice(0, 16)}`;
}
