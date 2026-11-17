import { describeSurfaceCases } from '../testing/surface-cases';
import { C_SURFACE } from './c.surface';

describeSurfaceCases(C_SURFACE, 'src/server.c', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'c.main',
        code: 'int main(int argc, char **argv) {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'c.socket.recv',
        code: '    n = recv(client_fd, buf, sizeof(buf), 0);',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'c.cgi.env',
        code: '    char *qs = getenv("QUERY_STRING");',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'c.stdin',
        code: '    fgets(line, sizeof(line), stdin);',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'c.http.embedded',
        code: '    d = MHD_start_daemon(MHD_USE_SELECT_INTERNALLY, 8080, NULL, NULL, &handler, NULL, MHD_OPTION_END);',
    },
    {
        role: 'entry_point',
        match: false,
        code: 'static int helper(int x) { return x + 1; }',
    },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'c.auth',
        code: '    rc = pam_authenticate(pamh, 0);',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'c.exec.shell',
        code: '    system(cmd);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'c.exec.command-format',
        code: '    snprintf(cmd, sizeof(cmd), "ping -c 1 %s", host);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    execv("/usr/bin/ping", args);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    system("clear");',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'c.format-string',
        code: '    printf(user_input);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    printf("%s\\n", user_input);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'c.sql.string-built',
        code: '    sprintf(q, "SELECT * FROM users WHERE name = \'%s\'", name);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'c.sql.string-built',
        code: '    rc = sqlite3_exec(db, query, cb, 0, &err);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    sqlite3_prepare_v2(db, "SELECT * FROM users WHERE id = ?", -1, &stmt, NULL);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'c.path.traversal',
        code: '    fp = fopen(argv[1], "r");',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'c.http.variable-url',
        code: '    curl_easy_setopt(curl, CURLOPT_URL, url);',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '    curl_easy_setopt(curl, CURLOPT_URL, "https://api.example.com/health");',
    },

    // authz (only the language-agnostic SQL-by-id pattern applies)
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'c.common.sql-by-id-only',
        code: '    const char *q = "SELECT * FROM invoices WHERE id = ?";',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '    const char *q = "SELECT * FROM invoices WHERE id = ? AND owner_id = ?";',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'c.log.sensitive',
        code: '    printf("login %s password=%s\\n", user, password);',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '    printf("login ok for %d\\n", uid);',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'c.common.hardcoded-secret',
        code: 'static const char *password = "Sup3rS3cret!";',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'c.secret.define',
        code: '#define API_KEY "0123456789abcdef"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'c.crypto.weak-hash',
        code: '    MD5_Init(&ctx);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'c.crypto.weak-cipher',
        code: '    EVP_EncryptInit_ex(ctx, EVP_aes_128_ecb(), NULL, key, NULL);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'c.crypto.insecure-random',
        code: '    srand(time(NULL));',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'c.crypto.timing-unsafe-compare',
        code: '    if (memcmp(mac, expected_mac, 32) == 0) {',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'c.tls.verification-disabled',
        code: '    SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    if (CRYPTO_memcmp(mac, expected_mac, 32) == 0) {',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    EVP_DigestInit_ex(ctx, EVP_sha256(), NULL);',
    },
]);
