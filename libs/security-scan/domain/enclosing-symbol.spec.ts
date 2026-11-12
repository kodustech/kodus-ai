import { codeLines, enclosingSymbol } from './enclosing-symbol';

const lineOf = (source: string, marker: string) =>
    source.split('\n').findIndex((l) => l.includes(marker)) + 1;

describe('enclosingSymbol', () => {
    it('names a NestJS controller method with its class', () => {
        const src = `@Controller('orders')
export class OrdersController {
    constructor(private readonly orders: OrdersService) {}

    @Get(':id')
    async findOne(@Param('id') id: string) {
        if (!id) {
            throw new BadRequestException();
        }
        return this.orders.findById(id); // SINK
    }
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'OrdersController.findOne',
        );
    });

    it('names an Express handler assigned to a const', () => {
        const src = `const getUser = async (req, res) => {
    const user = await db.query("select * from users where id = " + req.params.id); // SINK
    res.json(user);
};`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('getUser');
    });

    it('names a Python method with its class', () => {
        const src = `class OrderView(APIView):
    def get(self, request, pk):
        order = Order.objects.get(pk=pk)  # SINK
        return Response(order)
`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('OrderView.get');
    });

    it('names a top-level Python function', () => {
        const src = `import os

def run(cmd):
    os.system(cmd)  # SINK
`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('run');
    });

    it('names a Go method by its receiver type', () => {
        const src = `func (h *OrderHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	row := h.db.QueryRow("select * from orders where id = " + id) // SINK
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'OrderHandler.Get',
        );
    });

    it('names a Java method with its class', () => {
        const src = `@RestController
public class OrderController {
    @GetMapping("/orders/{id}")
    public Order get(@PathVariable Long id) {
        return repo.findById(id).get(); // SINK
    }
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'OrderController.get',
        );
    });

    it('names a Ruby action with its class', () => {
        const src = `class OrdersController < ApplicationController
  def show
    @order = Order.find(params[:id]) # SINK
  end
end`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'OrdersController.show',
        );
    });

    it('does not mistake control flow for a function', () => {
        const src = `function handler(req) {
    if (req.admin) {
        for (const x of req.items) {
            exec("rm " + x); // SINK
        }
    }
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('handler');
    });

    it('gives the same name when lines above the function move', () => {
        const a = `function handler(req) {
    exec(req.query.cmd); // SINK
}`;
        const b = `// a new comment
import x from 'y';

function handler(req) {
    exec(req.query.cmd); // SINK
}`;
        expect(enclosingSymbol(a, lineOf(a, 'SINK'))).toBe(
            enclosingSymbol(b, lineOf(b, 'SINK')),
        );
    });

    it('returns nothing for top-level code', () => {
        const src = `const secret = "hunter2"; // SINK`;
        expect(enclosingSymbol(src, 1)).toBeUndefined();
    });

    it('does not read a bare call above the line as a declaration', () => {
        const py = `def handle(request):
    log(request)
    print(request.GET)
    os.system(request.GET["cmd"])  # SINK
`;
        expect(enclosingSymbol(py, lineOf(py, 'SINK'))).toBe('handle');

        const go = `func Handle(w http.ResponseWriter, r *http.Request) {
	log.Println(r)
	validate(r)
	exec.Command("sh", "-c", r.FormValue("cmd")).Run() // SINK
}`;
        expect(enclosingSymbol(go, lineOf(go, 'SINK'))).toBe('Handle');
    });

    it('names a method whose signature spans lines', () => {
        const src = `export class UsersService {
    public async update(
        id: string,
        body: UpdateUserDto,
    ): Promise<User> {
        return this.repo.save({ ...body, id }); // SINK
    }
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'UsersService.update',
        );
    });

    it('does not read a declaration inside a block comment or a string', () => {
        const src = `function handler(req) {
    /*
    function legacyHandler(req) {
    */
    const help = \`
function fake(x) {
\`;
    return db.query(req.query.sql); // SINK
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('handler');
    });

    it('skips a function that closed before the line', () => {
        const src = `function outer() {
    function helper() {
        return 1;
    }
    exec(input); // SINK
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('outer');
    });

    it('does not count a brace inside a string', () => {
        const src = `function render(name) {
    const open = "}";
    return eval(name); // SINK
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('render');
    });

    it('skips a Python function whose body ended above the line', () => {
        const src = `def helper():
    return 1

result = eval(user_input)  # SINK`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBeUndefined();
    });
});

describe('enclosingSymbol — every line of one function gives one name', () => {
    const controller = `@Controller('orders')
export class OrdersController {
    @Get(':id') // DECORATOR
    @UseGuards(AuthGuard)
    async findOne(@Param('id') id: string) {
        const order = await this.orders.findById(id);

        return order; // AFTER-BLANK
    }
}`;

    it('names a blank line inside the body like the lines around it', () => {
        const blank =
            controller
                .split('\n')
                .findIndex((l, i, all) => !l.trim() && i > 4) + 1;
        expect(enclosingSymbol(controller, blank)).toBe(
            'OrdersController.findOne',
        );
        expect(
            enclosingSymbol(controller, lineOf(controller, 'AFTER-BLANK')),
        ).toBe('OrdersController.findOne');
    });

    it('names a decorator line by the method it decorates', () => {
        expect(
            enclosingSymbol(controller, lineOf(controller, 'DECORATOR')),
        ).toBe('OrdersController.findOne');
    });

    it('names a method whose brace opens on the next line (Allman)', () => {
        const src = `public class OrdersController : Controller
{
    [HttpGet("{id}")]
    public IActionResult Get(int id)
    {
        var order = _db.Orders.Find(id); // SINK
        return Ok(order);
    }
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'OrdersController.Get',
        );
    });

    it('does not let braces inside a multi-line signature close the body', () => {
        const src = `export class UsersService {
    async update(
        { id, role }: UpdateUserDto,
        options = {},
    ) {
        return this.repo.save({ id, role }); // SINK
    }
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'UsersService.update',
        );
    });

    it.each([
        ['go func', 'go func() {'],
        ['defer func', 'defer func() {'],
    ])(
        'names the function around a %s closure, not the closure',
        (_name, opener) => {
            const src = `func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
	${opener}
		exec.Command("sh", "-c", r.URL.Query().Get("q")) // SINK
	}()
}`;
            expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
                'Server.Handle',
            );
        },
    );

    it('names the method around a synchronized block or an anonymous class', () => {
        const src = `public class Jobs {
    public void run(String cmd) {
        synchronized (lock) {
            Runtime.getRuntime().exec(cmd); // SYNC
        }
        pool.submit(new Callable<String>() {
            public String call() {
                return "x"; // ANON
            }
        });
    }
}`;
        expect(enclosingSymbol(src, lineOf(src, 'SYNC'))).toBe('Jobs.run');
        // A method of the anonymous class is named by itself, like any
        // function nested in another; the `new Callable()` line never is.
        expect(enclosingSymbol(src, lineOf(src, 'ANON'))).toBe('call');
    });

    it('names Go generic functions and methods', () => {
        const fn = `func Map[T any](items []T) []T {
	return items // SINK
}`;
        const method = `func (r *Repo[T]) Find(id string) T {
	return r.db.Get(id) // SINK
}`;
        expect(enclosingSymbol(fn, lineOf(fn, 'SINK'))).toBe('Map');
        expect(enclosingSymbol(method, lineOf(method, 'SINK'))).toBe(
            'Repo.Find',
        );
    });

    it('stays fast on a very long line', () => {
        const src = `function render(input) {
    return "${'a('.repeat(40000)}"; // SINK
}`;
        const started = Date.now();
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('render');
        expect(Date.now() - started).toBeLessThan(200);
    });
});

describe('codeLines', () => {
    it('keeps one line per source line when a string continues past a backslash', () => {
        const src = [
            'const banner = "first \\',
            'second";',
            'function handler(req) {',
            '    run(req.query.cmd); // SINK',
            '}',
        ].join('\n');

        expect(codeLines(src)).toHaveLength(5);
        expect(codeLines(src)[1].trim()).toBe(';');
        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe('handler');
    });
});

describe('codeLines: trailing comments', () => {
    it('reads a declaration with a comment after its colon', () => {
        const src = [
            'class Handler:',
            '    def handle(self):  # entry point',
            "        data = {'q': request.args['q']}",
            '        run(data)  # SINK }',
            '',
        ].join('\n');

        expect(enclosingSymbol(src, lineOf(src, 'SINK'))).toBe(
            'Handler.handle',
        );
        expect(codeLines(src)[3]).not.toContain('}');
    });

    it('names two methods whose bodies sit on their signature line apart', () => {
        const source = [
            'class OrdersRepo {',
            '    find(id) { return db.query(`SELECT * FROM o WHERE id = ${id}`); }',
            '    remove(id) { return db.query(`DELETE FROM o WHERE id = ${id}`); }',
            '}',
        ].join('\n');

        expect(enclosingSymbol(source, 2)).toBe('OrdersRepo.find');
        expect(enclosingSymbol(source, 3)).toBe('OrdersRepo.remove');
    });

    it('still reads a call on a line of its own as no declaration', () => {
        const source = ['function run() {', '    print(x)', '    go(y)', '}'].join('\n');

        expect(enclosingSymbol(source, 2)).toBe('run');
    });
});

