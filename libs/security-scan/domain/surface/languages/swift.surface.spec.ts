import { describeSurfaceCases } from '../testing/surface-cases';
import { SWIFT_SURFACE } from './swift.surface';

describeSurfaceCases(
    SWIFT_SURFACE,
    'Sources/App/Controllers/UserController.swift',
    [
        // entry points
        {
            role: 'entry_point',
            match: true,
            patternId: 'swift.vapor.route',
            code: '    app.get("hello") { req async -> String in',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'swift.vapor.route',
            code: '        users.post(":id", "avatar", use: uploadAvatar)',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'swift.vapor.collection',
            code: 'struct UserController: RouteCollection {',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'swift.vapor.handler',
            code: '    func show(req: Request) async throws -> UserDTO {',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'swift.ios.url-open',
            code: '    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'swift.cli',
            code: 'let args = CommandLine.arguments',
        },
        {
            role: 'entry_point',
            match: false,
            code: '    let value = dictionary["key"]',
        },

        // auth checks
        {
            role: 'auth_check',
            match: true,
            patternId: 'swift.vapor.auth',
            code: '        let protected = routes.grouped(UserToken.authenticator(), User.guardMiddleware())',
        },
        {
            role: 'auth_check',
            match: true,
            patternId: 'swift.vapor.auth',
            code: '        let user = try req.auth.require(User.self)',
        },

        // injection
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'swift.sql.string-built',
            code: '    let rows = try db.prepare("SELECT * FROM users WHERE name = \'\\(name)\'")',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '    let rows = try db.execute(sql: "SELECT * FROM users WHERE id = ?", arguments: [id])',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '    try await sql.raw("SELECT * FROM users WHERE id = \\(bind: id)").all()',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'swift.sql.raw-call',
            code: '    sqlite3_exec(db, query, nil, nil, nil)',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'swift.exec',
            code: '    task.launchPath = "/bin/sh"\n    task.arguments = ["-c", command]',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '    task.executableURL = URL(fileURLWithPath: "/usr/bin/git")\n    task.arguments = ["clone", "--", repoURL]',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'swift.eval',
            code: '    let value = NSExpression(format: userFormula).expressionValue(with: nil, context: nil)',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'swift.predicate.injection',
            code: '    let p = NSPredicate(format: "name == \'\\(query)\'")',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'swift.path.traversal',
            code: '    return req.fileio.streamFile(at: path)',
        },

        // ssrf
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'swift.http.variable-url',
            code: '    let res = try await req.client.get(URI(string: target))',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'swift.http.variable-url',
            code: '    guard let url = URL(string: "https://\\(host)/status") else { return }',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: false,
            code: '    let url = URL(string: "https://api.example.com/health")!',
        },

        // authz
        {
            role: 'sink',
            vulnClass: 'authz',
            match: true,
            patternId: 'swift.orm.by-id-only',
            code: '        guard let todo = try await Todo.find(req.parameters.get("todoID"), on: req.db) else {',
        },
        {
            role: 'sink',
            vulnClass: 'authz',
            match: false,
            code: '        let todos = try await user.$todos.query(on: req.db).all()',
        },

        // data exposure
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'swift.log.sensitive',
            code: '    print("login \\(user) password=\\(password)")',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'swift.storage.plaintext-secret',
            code: '    UserDefaults.standard.set(accessToken, forKey: "accessToken")',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'swift.response.error-detail',
            code: '        throw Abort(.internalServerError, reason: error.localizedDescription)',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'swift.response.whole-entity',
            code: '    func me(req: Request) async throws -> User {',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: false,
            code: '    func me(req: Request) async throws -> User.Public {',
        },

        // secret / identity
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'swift.common.hardcoded-secret',
            code: '    let apiKey = "pk_9f8e7d6c5b4a3210"',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'swift.crypto.weak-hash',
            code: '    let digest = Insecure.MD5.hash(data: data)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'swift.crypto.weak-cipher',
            code: '    CCCrypt(op, CCAlgorithm(kCCAlgorithmDES), options, key, keyLen, nil, input, inLen, out, outLen, &moved)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'swift.crypto.insecure-random',
            code: '    let otp = rand() % 1000000',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'swift.crypto.timing-unsafe-compare',
            code: '    if computed == expectedSignature { return true }',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'swift.jwt.unverified',
            code: '    let jwt = try decode(jwt: token)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'swift.tls.verification-disabled',
            code: '        completionHandler(.useCredential, URLCredential(trust: challenge.protectionSpace.serverTrust!))',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '    let otp = Int.random(in: 100000...999999)',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '    let digest = SHA256.hash(data: data)',
        },
    ],
);
