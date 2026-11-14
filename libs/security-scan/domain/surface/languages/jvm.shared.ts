import { SurfacePattern } from '../surface.types';
import { any, auth, entry, randomForSecret, sink } from './shared';

// Spring, JAX-RS and the JCA crypto APIs read the same in Java, Kotlin and
// Scala source, so these factories are shared and only the id prefix changes.

export function springEntries(prefix: string): SurfacePattern[] {
    return [
        entry(
            `${prefix}.spring.route`,
            String.raw`@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b`,
            'spring',
        ),
        entry(
            `${prefix}.jaxrs.route`,
            String.raw`@(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|@Path\(`,
            'jax-rs',
        ),
        entry(
            `${prefix}.messaging.listener`,
            String.raw`@(?:KafkaListener|RabbitListener|JmsListener|SqsListener|StreamListener|MessageMapping|GrpcService)\b`,
            'spring',
        ),
        entry(
            `${prefix}.graphql.mapping`,
            String.raw`@(?:QueryMapping|MutationMapping|SchemaMapping|SubscriptionMapping)\b`,
            'spring-graphql',
        ),
    ];
}

export function springAuth(prefix: string): SurfacePattern {
    return auth(
        `${prefix}.spring.auth`,
        String.raw`@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed|PreFilter|PostFilter)\b|\.(?:hasRole|hasAuthority|hasAnyRole|hasAnyAuthority|authenticated)\(|\bContainerRequestFilter\b`,
        'spring/jax-rs',
    );
}

export function jcaCrypto(prefix: string): SurfacePattern[] {
    return [
        sink(
            `${prefix}.crypto.weak-hash`,
            'secret_identity',
            'CWE-328',
            String.raw`MessageDigest\.getInstance\(\s*"(?:MD5|MD2|MD4|SHA-?1|SHA)"|\bDigestUtils\.(?:md5|sha1|sha)\w*\(|\bHashing\.(?:md5|sha1)\(\)`,
        ),
        sink(
            `${prefix}.crypto.weak-cipher`,
            'secret_identity',
            'CWE-327',
            // Bare "AES" defaults to AES/ECB/PKCS5Padding.
            String.raw`Cipher\.getInstance\(\s*"(?:DES|DESede|RC2|RC4|ARCFOUR|Blowfish|AES"|[^"]*/ECB)`,
        ),
        sink(
            `${prefix}.crypto.insecure-random`,
            'secret_identity',
            'CWE-338',
            any(
                randomForSecret(
                    String.raw`\bRandom\(\)|Math\.random\(\)|\bRandom\.next\w*\(|\.nextInt\(|\.nextLong\(`,
                ),
                String.raw`\bRandomStringUtils\.random\w*\(`,
            ),
        ),
        sink(
            `${prefix}.jwt.unverified`,
            'secret_identity',
            'CWE-347',
            String.raw`\.parseClaimsJwt\(|\.parseUnsecuredClaims\(|\bAlgorithm\.none\(\)|\bJWT\.decode\(|\.unsecured\(\)`,
        ),
        sink(
            `${prefix}.tls.verification-disabled`,
            'secret_identity',
            'CWE-295',
            String.raw`\bNoopHostnameVerifier\b|\bALLOW_ALL_HOSTNAME_VERIFIER\b|\bInsecureTrustManagerFactory\b|\bTrustAll\w*|(?:hostnameVerifier|setHostnameVerifier)\([^)]*->\s*true|\bacceptAnyCertificate\s*=\s*true`,
        ),
    ];
}

/** `x.equals(secret)`/`secret.equals(x)` is a short-circuit compare, like `==`. */
export const JVM_EQUALS_COMPARE = String.raw`(?:[Ss]ecret|[Tt]oken|[Ss]ignature|[Hh]mac|[Dd]igest|[Aa]pi[Kk]ey|[Pp]assword)\w*\.equals\(|\.equals\(\s*[\w.]*(?:[Ss]ecret|[Tt]oken|[Ss]ignature|[Hh]mac|[Dd]igest|[Aa]pi[Kk]ey|[Pp]assword)|\bArrays\.equals\([^)]*(?:[Ss]ig|[Hh]mac|[Mm]ac|[Dd]igest|[Hh]ash)`;

/** Spring Data / JPA lookups by id alone. */
export const JPA_BY_ID_ONLY = String.raw`\b\w*[Rr]epository\.(?:findById|findByIdOrNull|getById|getOne|getReferenceById|deleteById)\(\s*[\w.()]+\s*\)|\b(?:em|entityManager)\.(?:find|getReference)\(\s*\w+(?:\.class|::class\.java)\s*,\s*[\w.()]+\s*\)`;
