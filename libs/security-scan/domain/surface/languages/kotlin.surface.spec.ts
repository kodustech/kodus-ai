import { describeSurfaceCases } from '../testing/surface-cases';
import { KOTLIN_SURFACE } from './kotlin.surface';

describeSurfaceCases(KOTLIN_SURFACE, 'src/main/kotlin/com/acme/Routes.kt', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'kt.spring.route',
        code: '    @PostMapping("/orders")',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'kt.jaxrs.route',
        code: '    @Path("/users")',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'kt.messaging.listener',
        code: '    @RabbitListener(queues = ["orders"])',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'kt.graphql.mapping',
        code: '    @MutationMapping',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'kt.ktor.route',
        code: '        get("/users/{id}") {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'kt.ktor.route',
        code: '    routing {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'kt.cli.main',
        code: 'fun main(args: Array<String>) {',
    },
    { role: 'entry_point', match: false, code: '    val x = map.get("key")' },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'kt.spring.auth',
        code: '    @Secured("ROLE_ADMIN")',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'kt.ktor.auth',
        code: '        authenticate("auth-jwt") {',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'kt.sql.string-built',
        code: '    val q = "SELECT * FROM users WHERE name = \'$name\'"',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'kt.sql.raw-call',
        code: '    val rs = stmt.executeQuery(sql)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    val ps = conn.prepareStatement("SELECT * FROM users WHERE id = ?")',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'kt.exec',
        code: '    Runtime.getRuntime().exec("ping $host")',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'kt.exec',
        code: '    ProcessBuilder(listOf("sh", "-c", cmd)).start()',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    ProcessBuilder(listOf("git", "clone", "--", repoUrl)).start()',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'kt.eval',
        code: '    val v = engine.eval(script)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'kt.path.traversal',
        code: '    val f = File("uploads/${call.parameters["name"]}")',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'kt.http.variable-url',
        code: '    val body = client.get(targetUrl).bodyAsText()',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'kt.http.variable-url',
        code: '    val text = URL("https://$host/status").readText()',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '    val body = client.get("https://api.example.com/health").bodyAsText()',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'kt.orm.by-id-only',
        code: '    val invoice = invoiceRepository.findByIdOrNull(id)',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'kt.orm.by-id-only',
        code: '    Invoices.select { Invoices.id eq invoiceId }.single()',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '    val invoice = invoiceRepository.findByIdAndOwnerId(id, ownerId)',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'kt.log.sensitive',
        code: '    logger.info("token=$token for $user")',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'kt.response.error-detail',
        code: '        call.respondText(e.message ?: "error", status = HttpStatusCode.InternalServerError)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'kt.response.whole-entity',
        code: '        call.respond(user)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '        call.respond(UserDto(user.id, user.name))',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'kt.common.hardcoded-secret',
        code: '    val apiKey: String = "abcd1234efgh5678"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'kt.crypto.weak-hash',
        code: '    val md = MessageDigest.getInstance("SHA-1")',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'kt.crypto.weak-cipher',
        code: '    val c = Cipher.getInstance("DES/CBC/PKCS5Padding")',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'kt.crypto.insecure-random',
        code: '    val otp = Random.nextInt(100000, 999999)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'kt.crypto.timing-unsafe-compare',
        code: '    if (provided == storedToken) return true',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'kt.jwt.unverified',
        code: '    val decoded = JWT.decode(token)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'kt.tls.verification-disabled',
        code: '    hostnameVerifier { _, _ -> true }\n    sslSocketFactory(TrustAllCerts.factory, trustManager)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    if (MessageDigest.isEqual(a, b)) return true',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '    val apiKey = System.getenv("API_KEY")',
    },
]);
