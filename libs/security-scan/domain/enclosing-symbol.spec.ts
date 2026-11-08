import { enclosingSymbol } from './enclosing-symbol';

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
