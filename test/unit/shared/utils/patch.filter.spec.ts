import { extractLinesFromDiffHunk } from '../../../../src/shared/utils/patch';

describe('patch.ts - filterSuggestionsCodeDiff', () => {
    const filterSuggestionsCodeDiff = (
        patchWithLinesStr: string,
        codeSuggestions: any[],
    ) => {
        if (!codeSuggestions?.length) {
            return [];
        }

        const modifiedRanges = extractLinesFromDiffHunk(patchWithLinesStr);
        return codeSuggestions.filter((suggestion) => {
            return modifiedRanges.some(
                (range) =>
                    // The suggestion is completely within the range
                    (suggestion?.relevantLinesStart >= range.start &&
                        suggestion?.relevantLinesEnd <= range.end) ||
                    // The start of the suggestion is within the range
                    (suggestion?.relevantLinesStart >= range.start &&
                        suggestion?.relevantLinesStart <= range.end) ||
                    // The end of the suggestion is within the range
                    (suggestion?.relevantLinesEnd >= range.start &&
                        suggestion?.relevantLinesEnd <= range.end) ||
                    // The range is completely within the suggestion
                    (suggestion?.relevantLinesStart <= range.start &&
                        suggestion?.relevantLinesEnd >= range.end),
            );
        });
    };

    it('should filter suggestions completely inside modified range', () => {
        const diff = `@@ -10,6 +15,9 @@ class UserService {
__new hunk__
15    private logger: Logger;
16    private config: Config;
17 +   private cache: Cache;
18 +   private metrics: Metrics;
19 +   private tracer: Tracer;
20    private db: Database;`;

        const suggestions = [
            { relevantLinesStart: 16, relevantLinesEnd: 16 }, // outside
            { relevantLinesStart: 17, relevantLinesEnd: 19 }, // inside
            { relevantLinesStart: 20, relevantLinesEnd: 20 }, // outside
            { relevantLinesStart: 14, relevantLinesEnd: 14 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 17, relevantLinesEnd: 19 },
        ]);
    });

    it('should filter suggestions that partially overlap with modified range', () => {
        const diff = `@@ -20,7 +20,12 @@ class UserService {
__new hunk__
20    async getUser(id: string) {
21 -    return this.db.findUser(id);
22 +    const cached = await this.cache.get(id);
23 +    if (cached) {
24 +      return cached;
25 +    }
26 +    const user = await this.db.findUser(id);
27 +    await this.cache.set(id, user);
28 +    return user;
29    }`;

        const suggestions = [
            { relevantLinesStart: 19, relevantLinesEnd: 22 }, // overlap start
            { relevantLinesStart: 25, relevantLinesEnd: 30 }, // overlap end
            { relevantLinesStart: 21, relevantLinesEnd: 25 }, // overlap middle
            { relevantLinesStart: 30, relevantLinesEnd: 35 }, // outside
            { relevantLinesStart: 15, relevantLinesEnd: 18 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 19, relevantLinesEnd: 22 },
            { relevantLinesStart: 25, relevantLinesEnd: 30 },
            { relevantLinesStart: 21, relevantLinesEnd: 25 },
        ]);
    });

    it('should filter suggestions that completely contain modified range', () => {
        const diff = `@@ -30,6 +30,8 @@ class UserService {
__new hunk__
30    private async validateUser(user: User) {
31 +    if (!user.email) {
32 +      throw new ValidationError('Email is required');
33     }`;

        const suggestions = [
            { relevantLinesStart: 29, relevantLinesEnd: 34 }, // contains the entire range
            { relevantLinesStart: 31, relevantLinesEnd: 32 }, // within the range
            { relevantLinesStart: 34, relevantLinesEnd: 36 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 29, relevantLinesEnd: 34 },
            { relevantLinesStart: 31, relevantLinesEnd: 32 },
        ]);
    });

    it('should handle multiple modified ranges', () => {
        const diff = `@@ -10,6 +10,8 @@ class UserService {
__new hunk__
10    constructor() {
11      this.logger = new Logger();
12 +    this.cache = new Cache();
13 +    this.metrics = new Metrics();
14    }

@@ -30,6 +32,8 @@ class UserService {
__new hunk__
32    private async validateEmail(email: string) {
33 +    if (!email.includes('@')) {
34 +      throw new ValidationError('Invalid email format');
35     }`;

        const suggestions = [
            { relevantLinesStart: 11, relevantLinesEnd: 13 }, // overlap first range
            { relevantLinesStart: 33, relevantLinesEnd: 34 }, // inside second range
            { relevantLinesStart: 20, relevantLinesEnd: 25 }, // between ranges
            { relevantLinesStart: 40, relevantLinesEnd: 45 }, // after the ranges
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 11, relevantLinesEnd: 13 },
            { relevantLinesStart: 33, relevantLinesEnd: 34 },
        ]);
    });

    it('should handle empty or invalid suggestions', () => {
        const diff = `@@ -10,6 +10,8 @@ class UserService {
__new hunk__
10    private config: Config;
11 +   private cache: Cache;
12 +   private metrics: Metrics;
13    private db: Database;`;

        expect(filterSuggestionsCodeDiff(diff, [])).toEqual([]);
        expect(filterSuggestionsCodeDiff(diff, null)).toEqual([]);
        expect(filterSuggestionsCodeDiff(diff, [{}])).toEqual([]);
        expect(
            filterSuggestionsCodeDiff(diff, [
                { relevantLinesStart: null, relevantLinesEnd: null },
            ]),
        ).toEqual([]);
    });

    it('should handle suggestions with line ranges at boundaries', () => {
        const diff = `@@ -10,6 +10,8 @@ class UserService {
__new hunk__
10    private config: Config;
11 +   private cache: Cache;
12 +   private metrics: Metrics;
13    private db: Database;`;

        const suggestions = [
            { relevantLinesStart: 10, relevantLinesEnd: 11 }, // starts exactly at the beginning
            { relevantLinesStart: 12, relevantLinesEnd: 13 }, // ends exactly at the end
            { relevantLinesStart: 11, relevantLinesEnd: 12 }, // completely inside
            { relevantLinesStart: 9, relevantLinesEnd: 14 }, // encompasses the entire range
            { relevantLinesStart: 14, relevantLinesEnd: 15 }, // starts after the end
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 10, relevantLinesEnd: 11 },
            { relevantLinesStart: 12, relevantLinesEnd: 13 },
            { relevantLinesStart: 11, relevantLinesEnd: 12 },
            { relevantLinesStart: 9, relevantLinesEnd: 14 },
        ]);
    });

    it('should handle suggestions with exact line matches', () => {
        const diff = `@@ -20,7 +20,7 @@ class UserService {
__new hunk__
20    async getUser(id: string) {
21 -    return this.db.findUser(id);
22 +    return await this.db.findUser(id);
23    }`;

        const suggestions = [
            { relevantLinesStart: 22, relevantLinesEnd: 22 }, // exactly on the modified line
            { relevantLinesStart: 21, relevantLinesEnd: 21 }, // on the removed line
            { relevantLinesStart: 20, relevantLinesEnd: 23 }, // encompasses the change
            { relevantLinesStart: 19, relevantLinesEnd: 19 }, // outside the range
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 22, relevantLinesEnd: 22 },
            { relevantLinesStart: 20, relevantLinesEnd: 23 },
        ]);
    });

    it('should handle Python decorators and complex indentation', () => {
        const diff = `@@ -15,7 +15,12 @@ from django.db import models
__new hunk__
15  from django.contrib.auth.models import User
16  from django.core.validators import MinValueValidator
17 +from django.utils.decorators import method_decorator
18 +from django.views.decorators.cache import cache_page
19 +from django.views.decorators.vary import vary_on_cookie
20
21 -class ProductViewSet(viewsets.ModelViewSet):
22 +@method_decorator(cache_page(60 * 15))  # Cache for 15 minutes
23 +@method_decorator(vary_on_cookie)
24 +class ProductViewSet(viewsets.ModelViewSet):
25      queryset = Product.objects.all()
26      serializer_class = ProductSerializer
27 +    permission_classes = [IsAuthenticated]`;

        const suggestions = [
            { relevantLinesStart: 17, relevantLinesEnd: 19 }, // imports
            { relevantLinesStart: 22, relevantLinesEnd: 23 }, // decorators
            { relevantLinesStart: 27, relevantLinesEnd: 27 }, // permission
            { relevantLinesStart: 15, relevantLinesEnd: 16 }, // outside
            { relevantLinesStart: 25, relevantLinesEnd: 26 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 17, relevantLinesEnd: 19 },
            { relevantLinesStart: 22, relevantLinesEnd: 23 },
            { relevantLinesStart: 27, relevantLinesEnd: 27 },
        ]);
    });

    it('should handle Go interfaces and method implementations', () => {
        const diff = `@@ -25,8 +25,15 @@ type UserRepository interface {
__new hunk__
25      FindByID(ctx context.Context, id string) (*User, error)
26      Create(ctx context.Context, user *User) error
27 +     FindByEmail(ctx context.Context, email string) (*User, error)
28 +     UpdateRole(ctx context.Context, id string, role string) error
29 +     SoftDelete(ctx context.Context, id string) error
30  }
31
32 +func (r *userRepository) SoftDelete(ctx context.Context, id string) error {
33 +    span, ctx := opentracing.StartSpanFromContext(ctx, "UserRepository.SoftDelete")
34 +    defer span.Finish()
35 +
36 +    return r.db.Model(&User{}).Where("id = ?", id).Update("deleted_at", time.Now()).Error
37 +}
38 +
39  func (r *userRepository) FindByID(ctx context.Context, id string) (*User, error) {`;

        const suggestions = [
            { relevantLinesStart: 27, relevantLinesEnd: 29 }, // interface methods
            { relevantLinesStart: 32, relevantLinesEnd: 37 }, // implementation
            { relevantLinesStart: 25, relevantLinesEnd: 26 }, // outside
            { relevantLinesStart: 39, relevantLinesEnd: 40 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 27, relevantLinesEnd: 29 },
            { relevantLinesStart: 32, relevantLinesEnd: 37 },
        ]);
    });

    it('should handle Java annotations and complex method changes', () => {
        const diff = `@@ -30,12 +30,25 @@ import org.springframework.stereotype.Service;
__new hunk__
30  @Service
31  @Transactional
32 +@Slf4j
33 +@CacheConfig(cacheNames = "orders")
34  public class OrderService {
35      private final OrderRepository orderRepository;
36 +    private final OrderMapper orderMapper;
37 +    private final ApplicationEventPublisher eventPublisher;
38
39 -    public OrderDTO findById(Long id) {
40 -        return orderRepository.findById(id)
41 -            .map(this::toDTO)
42 -            .orElseThrow(() -> new ResourceNotFoundException("Order not found"));
43 +    @Cacheable(key = "#id")
44 +    @Transactional(readOnly = true)
45 +    public OrderDTO findById(Long id) {
46 +        log.debug("Request to get Order : {}", id);
47 +
48 +        return orderRepository.findById(id)
49 +            .map(orderMapper::toDto)
50 +            .orElseThrow(() -> {
51 +                log.error("Order not found : {}", id);
52 +                return new ResourceNotFoundException("Order not found");
53 +            });
54      }`;

        const suggestions = [
            { relevantLinesStart: 32, relevantLinesEnd: 33 }, // new annotations
            { relevantLinesStart: 36, relevantLinesEnd: 37 }, // new fields
            { relevantLinesStart: 43, relevantLinesEnd: 44 }, // method annotations
            { relevantLinesStart: 46, relevantLinesEnd: 53 }, // implementation
            { relevantLinesStart: 30, relevantLinesEnd: 31 }, // outside
            { relevantLinesStart: 35, relevantLinesEnd: 35 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 32, relevantLinesEnd: 33 },
            { relevantLinesStart: 36, relevantLinesEnd: 37 },
            { relevantLinesStart: 43, relevantLinesEnd: 44 },
            { relevantLinesStart: 46, relevantLinesEnd: 53 },
        ]);
    });

    it('should handle React/TypeScript component changes', () => {
        const diff = `@@ -20,15 +20,35 @@ import { useQuery } from '@tanstack/react-query';
__new hunk__
20  interface DataTableProps<T> {
21      data: T[];
22 -    columns: Column[];
23 +    columns: Column<T>[];
24 +    sorting?: {
25 +        column: keyof T;
26 +        direction: 'asc' | 'desc';
27 +    };
28 +    pagination?: {
29 +        pageSize: number;
30 +        currentPage: number;
31 +    };
32      onRowClick?: (row: T) => void;
33  }
34
35 -export function DataTable<T>({ data, columns, onRowClick }: DataTableProps<T>) {
36 +export function DataTable<T>({
37 +    data,
38 +    columns,
39 +    sorting,
40 +    pagination,
41 +    onRowClick
42 +}: DataTableProps<T>) {
43 +    const [sortedData, setSortedData] = useState<T[]>(() => {
44 +        if (!sorting) return data;
45 +        return [...data].sort((a, b) => {
46 +            const aValue = a[sorting.column];
47 +            const bValue = b[sorting.column];
48 +            return sorting.direction === 'asc'
49 +                ? aValue > bValue ? 1 : -1
50 +                : aValue < bValue ? 1 : -1;
51 +        });
52 +    });
53 +
54      return (
55 -        <table>
56 -            <tbody>
57 -                {data.map((row, index) => (
58 +        <Table>
59 +            <TableHeader columns={columns} sorting={sorting} />
60 +            <TableBody>
61 +                {sortedData.map((row, index) => (
62                      <tr key={index} onClick={() => onRowClick?.(row)}>`;

        const suggestions = [
            { relevantLinesStart: 22, relevantLinesEnd: 31 }, // interface changes
            { relevantLinesStart: 36, relevantLinesEnd: 42 }, // props destructuring
            { relevantLinesStart: 43, relevantLinesEnd: 52 }, // sorting logic
            { relevantLinesStart: 58, relevantLinesEnd: 61 }, // render changes
            { relevantLinesStart: 20, relevantLinesEnd: 21 }, // outside
            { relevantLinesStart: 33, relevantLinesEnd: 34 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 22, relevantLinesEnd: 31 },
            { relevantLinesStart: 36, relevantLinesEnd: 42 },
            { relevantLinesStart: 43, relevantLinesEnd: 52 },
            { relevantLinesStart: 58, relevantLinesEnd: 61 },
        ]);
    });

    it('should handle large Ruby on Rails changes', () => {
        const diff = `@@ -25,10 +25,30 @@ class OrdersController < ApplicationController
__new hunk__
25    before_action :set_order, only: [:show, :update, :destroy]
26    before_action :authenticate_user!
27 +   before_action :authorize_order!
28 +
29 +   after_action :track_view, only: [:show]
30 +   around_action :with_logging
31 +
32 +   rescue_from ActiveRecord::RecordNotFound do |e|
33 +     render json: { error: 'Order not found' }, status: :not_found
34 +   end
35
36    def index
37 -    @orders = Order.all
38 -    render json: @orders
39 +    @orders = current_user.orders
40 +                         .includes(:items, :customer)
41 +                         .order(created_at: :desc)
42 +                         .page(params[:page])
43 +                         .per(params[:per_page])
44 +
45 +    render json: {
46 +      orders: ActiveModelSerializers::SerializableResource.new(
47 +        @orders,
48 +        each_serializer: OrderSerializer,
49 +        scope: current_user,
50 +        scope_name: :current_user
51 +      ),
52 +      meta: {
53 +        total_pages: @orders.total_pages,
54 +        current_page: @orders.current_page,
55 +        total_count: @orders.total_count
56 +      }
57 +    }
58    end`;

        const suggestions = [
            { relevantLinesStart: 27, relevantLinesEnd: 34 }, // callbacks and error handling
            { relevantLinesStart: 39, relevantLinesEnd: 43 }, // query building
            { relevantLinesStart: 45, relevantLinesEnd: 57 }, // response formatting
            { relevantLinesStart: 25, relevantLinesEnd: 26 }, // outside
            { relevantLinesStart: 36, relevantLinesEnd: 36 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 27, relevantLinesEnd: 34 },
            { relevantLinesStart: 39, relevantLinesEnd: 43 },
            { relevantLinesStart: 45, relevantLinesEnd: 57 },
        ]);
    });

    it('should handle Rust trait implementations', () => {
        const diff = `@@ -30,12 +30,35 @@ use tokio::sync::RwLock;
__new hunk__
30  #[async_trait]
31  pub trait UserRepository: Send + Sync {
32 -    async fn find_by_id(&self, id: Uuid) -> Result<User>;
33 -    async fn create(&self, user: NewUser) -> Result<User>;
34 +    /// Find a user by their unique identifier
35 +    ///
36 +    /// # Arguments
37 +    /// * \`id\` - The user's UUID
38 +    ///
39 +    /// # Returns
40 +    /// * \`Ok(User)\` - The user was found
41 +    /// * \`Err(Error)\` - The user was not found or another error occurred
42 +    async fn find_by_id(&self, id: Uuid) -> Result<User>;
43 +
44 +    /// Create a new user
45 +    ///
46 +    /// # Arguments
47 +    /// * \`user\` - The user data to create
48 +    ///
49 +    /// # Returns
50 +    /// * \`Ok(User)\` - The user was created successfully
51 +    /// * \`Err(Error)\` - The user could not be created
52 +    async fn create(&self, user: NewUser) -> Result<User>;
53 +
54 +    /// Find a user by their email address
55 +    ///
56 +    /// # Arguments
57 +    /// * \`email\` - The email address to search for
58 +    ///
59 +    /// # Returns
60 +    /// * \`Ok(User)\` - The user was found
61 +    /// * \`Err(Error)\` - The user was not found or another error occurred
62 +    async fn find_by_email(&self, email: &str) -> Result<User>;
63  }`;

        const suggestions = [
            { relevantLinesStart: 34, relevantLinesEnd: 42 }, // documentation for find_by_id
            { relevantLinesStart: 44, relevantLinesEnd: 52 }, // documentation for create
            { relevantLinesStart: 54, relevantLinesEnd: 62 }, // new method find_by_email
            { relevantLinesStart: 30, relevantLinesEnd: 31 }, // outside
            { relevantLinesStart: 33, relevantLinesEnd: 33 }, // outside
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            { relevantLinesStart: 34, relevantLinesEnd: 42 },
            { relevantLinesStart: 44, relevantLinesEnd: 52 },
            { relevantLinesStart: 54, relevantLinesEnd: 62 },
        ]);
    });

    it('should filter suggestions for NewsForm component', () => {
        const diff = `@@ -0,0 +1,107 @@
__new hunk__
1 +import { useState } from 'react';
2 +import { Form, Input, DatePicker, Button, Upload, message } from 'antd';
3 +import { SaveOutlined, UploadOutlined } from '@ant-design/icons';
4 +
5 +const NewsForm = () => {
6 +  const [form] = Form.useForm();
7 +  const [loading, setLoading] = useState(false);
8 +
9 +  const onFinish = async (values) => {
10 +    try {
11 +      setLoading(true);
12 +      // Converter a imagem para FormData quando implementar a API
13 +      const formData = {
14 +        ...values,
15 +        createdAt: values.createdAt.format('YYYY-MM-DD'),
16 +        image: values.image?.fileList[0]?.originFileObj
17 +      };
18 +
19 +      console.log('Dados do formulário:', formData);
20 +      message.success('Notícia cadastrada com sucesso!');
21 +      form.resetFields();
22 +    } catch (error) {
23 +      message.error(\`Erro ao cadastrar notícia: \${error.message}\`);
24 +    } finally {
25 +      setLoading(false);
26 +    }
27 +  };
28 +
29 +  const normFile = (e) => {
30 +    if (Array.isArray(e)) {
31 +      return e;
32 +    }
33 +    return e?.fileList;
34 +  };
35 +
36 +  return (
37 +    <div className="card-container">
38 +      <h2>Cadastrar Nova Notícia</h2>
39 +      <Form
40 +        form={form}
41 +        layout="vertical"
42 +        onFinish={onFinish}
43 +      >
44 +        <Form.Item
45 +          name="title"
46 +          label="Título"
47 +          rules={[{ required: true, message: 'Por favor, insira o título da notícia' }]}
48 +        >
49 +          <Input />
50 +        </Form.Item>
51 +
52 +        <Form.Item
53 +          name="image"
54 +          label="Imagem"
55 +          valuePropName="fileList"
56 +          getValueFromEvent={normFile}
57 +          rules={[{ required: true, message: 'Por favor, selecione uma imagem' }]}
58 +        >
59 +          <Upload
60 +            listType="picture"
61 +            maxCount={1}
62 +            beforeUpload={() => false}
63 +          >
64 +            <Button icon={<UploadOutlined />}>Selecionar Imagem</Button>
65 +          </Upload>
66 +        </Form.Item>
67 +
68 +        <Form.Item
69 +          name="content"
70 +          label="Conteúdo"
71 +          rules={[{ required: true, message: 'Por favor, insira o conteúdo da notícia' }]}
72 +        >
73 +          <Input.TextArea rows={6} />
74 +        </Form.Item>
75 +
76 +        <Form.Item
77 +          name="createdAt"
78 +          label="Data de Criação"
79 +          rules={[{ required: true, message: 'Por favor, selecione a data' }]}
80 +        >
81 +          <DatePicker style={{ width: '100%' }} />
82 +        </Form.Item>
83 +
84 +        <Form.Item
85 +          name="author"
86 +          label="Autor"
87 +          rules={[{ required: true, message: 'Por favor, insira o nome do autor' }]}
88 +        >
89 +          <Input />
90 +        </Form.Item>
91 +
92 +        <Form.Item>
93 +          <Button
94 +            type="primary"
95 +            htmlType="submit"
96 +            icon={<SaveOutlined />}
97 +            loading={loading}
98 +          >
99 +            Cadastrar Notícia
100 +          </Button>
101 +        </Form.Item>
102 +      </Form>
103 +    </div>
104 +  );
105 +};
106 +
107 +export default NewsForm;`;

        const suggestions = [
            {
                relevantFile: 'src/components/NewsForm.jsx',
                language: 'JavaScript',
                suggestionContent:
                    'Adicionar validação de tipo e tamanho de arquivo na imagem para prevenir uploads maliciosos ou muito grandes',
                existingCode: 'beforeUpload={() => false}',
                improvedCode:
                    "beforeUpload={(file) => {\n  const isJpgOrPng = file.type === 'image/jpeg' || file.type === 'image/png';\n  const isLt2M = file.size / 1024 / 1024 < 2;\n  if (!isJpgOrPng) message.error('Você só pode fazer upload de arquivos JPG/PNG!');\n  if (!isLt2M) message.error('A imagem deve ser menor que 2MB!');\n  return false;\n}}",
                oneSentenceSummary:
                    'Implementar validação de arquivo para garantir segurança no upload de imagens',
                relevantLinesStart: 62,
                relevantLinesEnd: 62,
                label: 'security',
            },
            {
                relevantFile: 'src/components/NewsForm.jsx',
                language: 'JavaScript',
                suggestionContent:
                    'Adicionar tratamento de erro específico para diferentes tipos de falhas durante o envio do formulário',
                existingCode:
                    'catch (error) {\n      message.error(`Erro ao cadastrar notícia: ${error.message}`);\n    }',
                improvedCode:
                    "catch (error) {\n      if (error.name === 'NetworkError') {\n        message.error('Erro de conexão. Verifique sua internet.');\n      } else if (error.response?.status === 413) {\n        message.error('Arquivo muito grande para upload.');\n      } else {\n        message.error(`Erro ao cadastrar notícia: ${error.message}`);\n      }\n    }",
                oneSentenceSummary:
                    'Melhorar o tratamento de erros com mensagens específicas para cada tipo de falha',
                relevantLinesStart: 22,
                relevantLinesEnd: 24,
                label: 'error_handling',
            },
        ];

        const result = filterSuggestionsCodeDiff(diff, suggestions);
        expect(result).toEqual([
            {
                relevantFile: 'src/components/NewsForm.jsx',
                language: 'JavaScript',
                suggestionContent:
                    'Adicionar validação de tipo e tamanho de arquivo na imagem para prevenir uploads maliciosos ou muito grandes',
                existingCode: 'beforeUpload={() => false}',
                improvedCode:
                    "beforeUpload={(file) => {\n  const isJpgOrPng = file.type === 'image/jpeg' || file.type === 'image/png';\n  const isLt2M = file.size / 1024 / 1024 < 2;\n  if (!isJpgOrPng) message.error('Você só pode fazer upload de arquivos JPG/PNG!');\n  if (!isLt2M) message.error('A imagem deve ser menor que 2MB!');\n  return false;\n}}",
                oneSentenceSummary:
                    'Implementar validação de arquivo para garantir segurança no upload de imagens',
                relevantLinesStart: 62,
                relevantLinesEnd: 62,
                label: 'security',
            },
            {
                relevantFile: 'src/components/NewsForm.jsx',
                language: 'JavaScript',
                suggestionContent:
                    'Adicionar tratamento de erro específico para diferentes tipos de falhas durante o envio do formulário',
                existingCode:
                    'catch (error) {\n      message.error(`Erro ao cadastrar notícia: ${error.message}`);\n    }',
                improvedCode:
                    "catch (error) {\n      if (error.name === 'NetworkError') {\n        message.error('Erro de conexão. Verifique sua internet.');\n      } else if (error.response?.status === 413) {\n        message.error('Arquivo muito grande para upload.');\n      } else {\n        message.error(`Erro ao cadastrar notícia: ${error.message}`);\n      }\n    }",
                oneSentenceSummary:
                    'Melhorar o tratamento de erros com mensagens específicas para cada tipo de falha',
                relevantLinesStart: 22,
                relevantLinesEnd: 24,
                label: 'error_handling',
            },
        ]);
    });
});
