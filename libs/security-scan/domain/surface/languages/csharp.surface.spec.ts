import { describeSurfaceCases } from '../testing/surface-cases';
import { CSHARP_SURFACE } from './csharp.surface';

describeSurfaceCases(CSHARP_SURFACE, 'src/Api/Controllers/UsersController.cs', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.aspnet.route',
        code: '    [HttpGet("{id}")]',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.aspnet.controller',
        code: 'public class UsersController : ControllerBase',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.aspnet.minimal-api',
        code: 'app.MapPost("/orders", async (Order o, Db db) => {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.razor.handler',
        code: '    public async Task<IActionResult> OnPostAsync()',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.functions.trigger',
        code: '    [HttpTrigger(AuthorizationLevel.Function, "post")] HttpRequest req,',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.messaging.consumer',
        code: 'public class OrderConsumer : IConsumer<OrderSubmitted>',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.cli.main',
        code: '    static async Task<int> Main(string[] args)',
    },
    {
        role: 'entry_point',
        match: false,
        code: '    private int Helper(int x) => x + 1;',
    },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'cs.aspnet.auth',
        code: '[Authorize(Roles = "Admin")]',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'cs.aspnet.auth',
        code: 'app.MapGet("/me", Me).RequireAuthorization();',
    },
    // Anonymous access is an entry point, never an auth check.
    {
        role: 'entry_point',
        match: true,
        patternId: 'cs.aspnet.anonymous',
        code: '    [AllowAnonymous]',
    },
    {
        role: 'auth_check',
        match: false,
        code: 'app.MapGet("/health", Health).AllowAnonymous();',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.sql.string-built',
        code: '        var sql = $"SELECT * FROM Users WHERE Name = \'{name}\'";',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.sql.raw-call',
        code: '        var users = db.Users.FromSqlRaw("SELECT * FROM Users WHERE Name = \'" + name + "\'");',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '        var users = db.Users.FromSqlInterpolated($"SELECT * FROM Users WHERE Name = {name}");',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '        var cmd = new SqlCommand("SELECT * FROM Users WHERE Id = @id", conn);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.exec',
        code: '        Process.Start("cmd.exe", "/c " + userCmd);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.exec',
        code: '        psi.Arguments = $"-c \\"{script}\\"";',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '        psi.ArgumentList.Add(userArg);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.eval',
        code: '        var result = await CSharpScript.EvaluateAsync(code);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.deserialize',
        code: '        var obj = new BinaryFormatter().Deserialize(stream);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.template.injection',
        code: '        var tpl = Template.Parse(userTemplate);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'cs.path.traversal',
        code: '        var path = Path.Combine(_root, file.FileName);',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'cs.http.variable-url',
        code: '        var resp = await _httpClient.GetAsync(callbackUrl);',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'cs.http.variable-url',
        code: '        var body = await client.GetStringAsync($"https://{host}/status");',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '        var resp = await _httpClient.GetAsync("https://api.example.com/health");',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'cs.orm.by-id-only',
        code: '        var invoice = await _db.Invoices.FindAsync(id);',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'cs.orm.by-id-only',
        code: '        var inv = await _db.Invoices.FirstOrDefaultAsync(i => i.Id == id);',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '        var inv = await _db.Invoices.FirstOrDefaultAsync(i => i.Id == id && i.OwnerId == userId);',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'cs.log.sensitive',
        code: '        _logger.LogInformation("Login {User} with password {Password}", user, password);',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'cs.response.error-detail',
        code: '            return StatusCode(500, ex.Message);',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'cs.response.whole-entity',
        code: '        return Ok(user);',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '        return Ok(new UserDto(user.Id, user.Name));',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cs.common.hardcoded-secret',
        code: '    private const string ApiKey = "4f3c2b1a0e9d8c7b";',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cs.crypto.weak-hash',
        code: '        using var md5 = MD5.Create();',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cs.crypto.weak-cipher',
        code: '        aes.Mode = CipherMode.ECB;',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cs.crypto.insecure-random',
        code: '        var resetCode = new Random().Next(100000, 999999);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cs.crypto.timing-unsafe-compare',
        code: '        if (signature.Equals(computed)) return true;',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cs.jwt.validation-disabled',
        code: '            ValidateIssuerSigningKey = false,',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'cs.tls.verification-disabled',
        code: '        handler.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '        if (CryptographicOperations.FixedTimeEquals(a, b)) return true;',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '        var resetCode = RandomNumberGenerator.GetInt32(100000, 999999);',
    },
]);
