import { describeSurfaceCases } from '../testing/surface-cases';
import { JAVA_SURFACE } from './java.surface';

describeSurfaceCases(
    JAVA_SURFACE,
    'src/main/java/com/acme/UserController.java',
    [
        // misconfiguration
        {
            role: 'sink',
            vulnClass: 'misconfiguration',
            match: true,
            patternId: 'java.config.csrf-off',
            code: 'http.csrf().disable();',
        },
        {
            role: 'sink',
            vulnClass: 'misconfiguration',
            match: true,
            patternId: 'java.config.csrf-off',
            code: 'http.csrf(AbstractHttpConfigurer::disable);',
        },
        {
            role: 'sink',
            vulnClass: 'misconfiguration',
            match: false,
            patternId: 'java.config.csrf-off',
            code: 'http.csrf(csrf -> csrf.ignoringRequestMatchers("/webhooks/**"));',
        },
        // entry points
        {
            role: 'entry_point',
            match: true,
            patternId: 'java.spring.route',
            code: '    @GetMapping("/users/{id}")',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'java.spring.route',
            code: '@RequestMapping("/api/orders")',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'java.jaxrs.route',
            code: '    @GET\n    @Path("/{id}")',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'java.messaging.listener',
            code: '    @KafkaListener(topics = "orders")',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'java.graphql.mapping',
            code: '    @QueryMapping',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'java.servlet',
            code: 'public class LoginServlet extends HttpServlet {',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'java.cli.main',
            code: '    public static void main(String[] args) {',
        },
        {
            role: 'entry_point',
            match: false,
            code: '    private void helper(String s) {',
        },

        // auth checks
        {
            role: 'auth_check',
            match: true,
            patternId: 'java.spring.auth',
            code: '    @PreAuthorize("hasRole(\'ADMIN\')")',
        },
        {
            role: 'auth_check',
            match: true,
            patternId: 'java.spring.auth',
            code: '        http.authorizeHttpRequests(a -> a.anyRequest().authenticated());',
        },

        // injection
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.sql.string-built',
            code: '        String q = "SELECT * FROM users WHERE name = \'" + name + "\'";',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.sql.raw-call',
            code: '        ResultSet rs = stmt.executeQuery(query);',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '        PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE id = ?");',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '        ResultSet rs = ps.executeQuery();',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.exec',
            code: '        Runtime.getRuntime().exec("ping " + host);',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.exec',
            code: '        new ProcessBuilder("sh", "-c", cmd).start();',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '        new ProcessBuilder("git", "clone", "--", repoUrl).start();',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.eval',
            code: '        Expression exp = parser.parseExpression(userInput);',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.deserialize',
            code: '        ObjectInputStream in = new ObjectInputStream(request.getInputStream());',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.template.injection',
            code: '        Velocity.evaluate(context, writer, "tpl", userTemplate);',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.path.traversal',
            code: '        File f = new File(uploadDir, request.getParameter("file"));',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.common.ldap-filter',
            code: '        ctx.search(base, "(uid=" + user + ")", controls);',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'java.common.xpath',
            code: '        xpath.evaluate("//user[@name=\'" + name + "\']", doc);',
        },

        // ssrf
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'java.http.variable-url',
            code: '        URL u = new URL(target);',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'java.http.variable-url',
            code: '        String body = restTemplate.getForObject(callbackUrl, String.class);',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: false,
            code: '        URL u = new URL("https://api.example.com/health");',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: false,
            code: '        URL u = new URL(BASE_URL);',
        },

        // authz
        {
            role: 'sink',
            vulnClass: 'authz',
            match: true,
            patternId: 'java.orm.by-id-only',
            code: '        return invoiceRepository.findById(id).orElseThrow();',
        },
        {
            role: 'sink',
            vulnClass: 'authz',
            match: true,
            patternId: 'java.common.sql-by-id-only',
            code: '    @Query("SELECT i FROM Invoice i WHERE i.id = :id")',
        },
        {
            role: 'sink',
            vulnClass: 'authz',
            match: false,
            code: '        return invoiceRepository.findByIdAndOwnerId(id, ownerId);',
        },

        // data exposure
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'java.log.sensitive',
            code: '        log.info("auth user={} password={}", user, password);',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'java.response.error-detail',
            code: '            e.printStackTrace();',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'java.response.whole-entity',
            code: '        return ResponseEntity.ok(userRepository.findById(id));',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: false,
            code: '        log.info("auth ok for user {}", userId);',
        },

        // secret / identity
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'java.common.hardcoded-secret',
            code: '    private static final String DB_PASSWORD = "Sup3rS3cret!";',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'java.crypto.weak-hash',
            code: '        MessageDigest md = MessageDigest.getInstance("MD5");',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'java.crypto.weak-cipher',
            code: '        Cipher c = Cipher.getInstance("AES/ECB/PKCS5Padding");',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'java.crypto.insecure-random',
            code: '        String token = RandomStringUtils.randomAlphanumeric(32);',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'java.crypto.timing-unsafe-compare',
            code: '        if (signature.equals(expected)) {',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'java.jwt.unverified',
            code: '        DecodedJWT jwt = JWT.decode(token);',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'java.tls.verification-disabled',
            code: '        builder.setSSLHostnameVerifier(NoopHostnameVerifier.INSTANCE);',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '        if (MessageDigest.isEqual(a, b)) {',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '        byte[] salt = new byte[16]; new SecureRandom().nextBytes(salt);',
        },
    ],
);
