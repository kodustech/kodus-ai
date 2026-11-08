import { describeSurfaceCases } from '../testing/surface-cases';
import { CPP_SURFACE } from './cpp.surface';

describeSurfaceCases(CPP_SURFACE, 'src/server.cpp', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.main',
        code: 'int main(int argc, char* argv[]) {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.http.route',
        code: '    CROW_ROUTE(app, "/users/<int>")([](int id) {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.http.route',
        code: '    svr.Post("/upload", [&](const httplib::Request& req, httplib::Response& res) {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.grpc.service',
        code: '  Status GetUser(grpc::ServerContext* ctx, const Req* req, Resp* resp) override {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.iostream.cin',
        code: '    std::getline(std::cin, line);',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.socket.recv',
        code: '    auto n = ::recv(fd, buf.data(), buf.size(), 0);',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.cgi.env',
        code: '    const char* qs = std::getenv("QUERY_STRING");',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.stdin',
        code: '    scanf("%d", &n);',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cpp.http.embedded',
        code: '    mg_http_listen(&mgr, "http://0.0.0.0:8000", fn, NULL);',
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
        patternId: 'cpp.http.auth',
        code: 'class LoginFilter : public drogon::HttpFilter<LoginFilter> {',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'cpp.auth',
        code: '    if (geteuid() != 0) return 1;',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cpp.exec.shell',
        code: '    std::system(cmd.c_str());',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cpp.exec.command-format',
        code: '    snprintf(cmd, sizeof cmd, "convert %s out.png", path);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    execv("/usr/bin/convert", args);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cpp.format-string',
        code: '    syslog(LOG_ERR, msg);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cpp.sql.concat',
        code: '    std::string q = "SELECT * FROM users WHERE name = \'" + name + "\'";',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cpp.sql.string-built',
        code: '    PQexec(conn, query.c_str());',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    PQexecParams(conn, "SELECT * FROM users WHERE id = $1", 1, NULL, values, NULL, NULL, 0);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cpp.path.traversal',
        code: '    int fd = open(req->uri, O_RDONLY);',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'cpp.http.variable-url',
        code: '    curl_easy_setopt(curl, CURLOPT_URL, target.c_str());',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'cpp.http.variable-url-client',
        code: '    auto r = cpr::Get(cpr::Url{callback_url});',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '    auto r = cpr::Get(cpr::Url{"https://api.example.com/health"});',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'cpp.common.sql-by-id-only',
        code: '    auto q = "SELECT * FROM invoices WHERE id = $1";',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '    auto q = "SELECT * FROM invoices WHERE id = $1 AND owner_id = $2";',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'cpp.log.sensitive',
        code: '    std::cout << "token=" << token << std::endl;',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '    std::cout << "user=" << uid << std::endl;',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cpp.common.hardcoded-secret',
        code: 'const std::string apiKey = "abcdef0123456789";',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cpp.secret.define',
        code: '#define DB_PASSWORD "changeme123!"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cpp.crypto.weak-hash',
        code: '    EVP_DigestInit_ex(ctx, EVP_md5(), nullptr);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cpp.crypto.weak-cipher',
        code: '    DES_ecb_encrypt(&in, &out, &ks, DES_ENCRYPT);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cpp.crypto.insecure-random',
        code: '    int sessionId = rand();',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cpp.crypto.timing-unsafe-compare',
        code: '    if (strcmp(token, expected) == 0) {',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cpp.tls.verification-disabled',
        code: '    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    RAND_bytes(sessionId, sizeof(sessionId));',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    const char* apiKey = std::getenv("API_KEY");',
    },
]);
