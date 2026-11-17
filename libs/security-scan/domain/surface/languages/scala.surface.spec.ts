import { describeSurfaceCases } from '../testing/surface-cases';
import { SCALA_SURFACE } from './scala.surface';

describeSurfaceCases(SCALA_SURFACE, 'app/controllers/UserController.scala', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'scala.play.routes-file',
        file: 'conf/routes',
        code: 'GET     /users/:id      controllers.UserController.show(id: Long)',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'scala.play.action',
        code: '  def show(id: Long) = Action.async { implicit request =>',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'scala.akka.route',
        code: '    path("users" / LongNumber) { id =>',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'scala.http4s.route',
        code: '    case GET -> Root / "users" / IntVar(id) =>',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'scala.cli.main',
        code: '  def main(args: Array[String]): Unit = {',
    },
    {
        role: 'entry_point',
        match: false,
        code: '  def helper(x: Int): Int = x + 1',
    },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'scala.auth',
        code: '  def admin = AuthenticatedAction.async { implicit req =>',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'scala.auth',
        code: '    authenticateOAuth2("realm", authenticator) { user =>',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'scala.sql.string-built',
        code: '    val q = s"SELECT * FROM users WHERE name = \'$name\'"',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'scala.sql.raw-call',
        code: '    val rs = stmt.executeQuery(query)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    sql"SELECT * FROM users WHERE id = $id".query[User].option',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'scala.exec',
        code: '    val out = s"ping -c 1 $host".!!',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'scala.exec',
        code: '    val rc = cmd.!',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '    val out = Process(Seq("git", "clone", "--", repoUrl)).!!',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'scala.eval',
        code: '    val result = tb.eval(tb.parse(code))',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'scala.path.traversal',
        code: '    Ok.sendFile(new File(s"uploads/$name"))',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'scala.http.variable-url',
        code: '    ws.url(callbackUrl).get()',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'scala.http.variable-url',
        code: '    Http().singleRequest(HttpRequest(uri = target))',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '    ws.url("https://api.example.com/health").get()',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'scala.orm.by-id-only',
        code: '    invoices.filter(_.id === invoiceId).result.headOption',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'scala.orm.by-id-only',
        code: '    invoiceRepo.findById(id)',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '    invoices.filter(i => i.id === invoiceId && i.ownerId === userId)',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'scala.log.sensitive',
        code: '    logger.info(s"login $user password=$password")',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'scala.response.error-detail',
        code: '      case e: Exception => InternalServerError(e.getMessage)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'scala.response.whole-entity',
        code: '    Ok(Json.toJson(user))',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '    Ok(Json.toJson(UserView(user.id, user.name)))',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.common.hardcoded-secret',
        code: '  val clientSecret = "f00b4rB4zQux1234"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.crypto.weak-hash',
        code: '  val md = MessageDigest.getInstance("MD5")',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.crypto.weak-cipher',
        code: '  val c = Cipher.getInstance("AES")',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.crypto.insecure-random',
        code: '  val sessionId = new Random().nextLong()',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.crypto.insecure-random-util',
        code: '  val token = Random.alphanumeric.take(32).mkString',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.crypto.timing-unsafe-compare',
        code: '  if (provided == expectedSignature) Ok else Forbidden',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.jwt.unverified',
        code: '  val claims = JWT.decode(token)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'scala.tls.verification-disabled',
        code: '  val ctx = TrustAllManager.context',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '  val clientSecret = sys.env("CLIENT_SECRET")',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '  if (MessageDigest.isEqual(a, b)) Ok else Forbidden',
    },
]);
