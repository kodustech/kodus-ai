import { extractLinesFromDiffHunk } from '../../../../src/shared/utils/patch';

describe('patch.ts', () => {
    describe('extractLinesFromDiffHunk', () => {
        it('should extract single line modifications', () => {
            const diff = `@@ -37,6 +37,7 @@ export function useSuspenseGetOnboardingPullRequests(teamId: string) {
__new hunk__
37              pull_number: number;
38              repository: string;
39              title: string;
40 +            url: string;
41          }[]
42      >(CODE_MANAGEMENT_API_PATHS.GET_ONBOARDING_PULL_REQUESTS, {
43          params: { teamId },`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 40, end: 40 }, // Addition of the url field
            ]);
        });

        it('should handle large file with multiple scattered changes', () => {
            const diff = `@@ -10,7 +10,7 @@ import { DotLoader } from "@components/ui/dot-loader";
__new hunk__
10  import { FormControl } from "@components/ui/form-control";
11  import { Heading } from "@components/ui/heading";
12 -import { SvgKody } from "@components/ui/icons/SvgKody";
13 +import { SvgKody, SvgLogo } from "@components/ui/icons";
14  import { Page } from "@components/ui/page";
15  import { Popover } from "@components/ui/popover";
16  import { useToast } from "@components/ui/toast";

@@ -45,12 +45,14 @@ interface PullRequestData {
__new hunk__
45    repository: string;
46    title: string;
47 +  description: string;
48 +  labels: string[];
49    created_at: string;
50    updated_at: string;
51 -  status: 'open' | 'closed';
52 +  status: 'open' | 'closed' | 'merged';
53    assignees: {
54      id: number;
55      login: string;
56 +    avatar_url: string;
57    }[];
58  }

@@ -98,6 +100,15 @@ export default function PullRequestList() {
__new hunk__
100   const [sortBy, setSortBy] = useState<'created' | 'updated'>('created');
101   const [filterStatus, setFilterStatus] = useState<string[]>([]);
102 +  const [searchQuery, setSearchQuery] = useState('');
103 +
104 +  // Debounce search query
105 +  const debouncedSearch = useDebounce(searchQuery, 300);
106 +
107 +  // Memoize filtered results
108 +  const filteredPRs = useMemo(() => {
109 +    return prs.filter(pr => pr.title.toLowerCase().includes(debouncedSearch.toLowerCase()));
110 +  }, [prs, debouncedSearch]);
111
112    const sortedPRs = useMemo(() => {
113      return [...prs].sort((a, b) => {

@@ -150,9 +161,17 @@ export default function PullRequestList() {
__new hunk__
161                <div className="flex items-center gap-2">
162                  <Avatar
163                    src={assignee.avatar_url}
164 -                  alt={assignee.login}
165 +                  alt={\`\${assignee.login}'s avatar\`}
166                    className="h-6 w-6"
167                  />
168 +                 <Tooltip>
169 +                   <TooltipTrigger>
170 +                     <span className="text-sm text-gray-600">
171 +                       {assignee.login}
172 +                     </span>
173 +                   </TooltipTrigger>
174 +                   <TooltipContent>
175 +                     Click to view profile
176 +                   </TooltipContent>
177 +                 </Tooltip>
178                </div>
179              ))}
180            </div>`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 13, end: 13 }, // Change in the import
                { start: 47, end: 48 }, // Addition of the description and labels fields
                { start: 52, end: 52 }, // Change in the status field
                { start: 56, end: 56 }, // Addition of the avatar_url field
                { start: 102, end: 110 }, // Addition of the search logic
                { start: 165, end: 165 }, // Change in the Avatar alt attribute
                { start: 168, end: 177 }, // Addition of the Tooltip component
            ]);
        });

        it('should handle complex refactoring with mixed changes', () => {
            const diff = `@@ -200,15 +200,25 @@ export class AuthService {
__new hunk__
200    private readonly logger = new Logger(AuthService.name);
201
202 -  async validateUser(email: string, password: string): Promise<any> {
203 -    const user = await this.usersService.findOne(email);
204 -    if (user && await bcrypt.compare(password, user.password)) {
205 -      const { password, ...result } = user;
206 -      return result;
207 -    }
208 -    return null;
209 +  async validateUser(email: string, password: string): Promise<UserDto | null> {
210 +    try {
211 +      // Find user and validate credentials
212 +      const user = await this.usersService.findOne(email);
213 +      if (!user) {
214 +        this.logger.warn(\`User not found: \${email}\`);
215 +        return null;
216 +      }
217 +
218 +      // Compare password hashes
219 +      const isPasswordValid = await bcrypt.compare(password, user.password);
220 +      if (!isPasswordValid) {
221 +        this.logger.warn(\`Invalid password for user: \${email}\`);
222 +        return null;
223 +      }
224 +
225 +      // Return user data without sensitive information
226 +      const { password: _, ...userDto } = user;
227 +      return userDto;
228 +    } catch (error) {
229 +      this.logger.error(\`Error validating user: \${error.message}\`);
230 +      throw new UnauthorizedException('Authentication failed');
231 +    }
232    }
233
234    async login(user: any) {`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 209, end: 231 }, // Addition of the new method with error handling
            ]);
        });

        it('should handle file renames and moves with content changes', () => {
            const diff = `@@ -0,0 +1,25 @@
__new hunk__
1 +// Moved from src/auth/guards/jwt.guard.ts to src/common/guards/auth.guard.ts
2 +import { Injectable, ExecutionContext } from '@nestjs/common';
3 +import { AuthGuard as NestAuthGuard } from '@nestjs/passport';
4 +import { Reflector } from '@nestjs/core';
5 +
6 +@Injectable()
7 +export class AuthGuard extends NestAuthGuard('jwt') {
8 +  constructor(private reflector: Reflector) {
9 +    super();
10 +  }
11 +
12 +  canActivate(context: ExecutionContext) {
13 +    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
14 +      context.getHandler(),
15 +      context.getClass(),
16 +    ]);
17 +
18 +    if (isPublic) {
19 +      return true;
20 +    }
21 +
22 +    return super.canActivate(context);
23 +  }
24 +}
25 +`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 1, end: 25 }, // Entire file is new
            ]);
        });

        it('should handle large deletions', () => {
            const diff = `@@ -150,25 +150,0 @@ export class UserController {
__new hunk__
150 -  @Delete(':id')
151 -  @UseGuards(AdminGuard)
152 -  async remove(@Param('id') id: string) {
153 -    try {
154 -      await this.userService.remove(id);
155 -      return {
156 -        message: 'User deleted successfully',
157 -      };
158 -    } catch (error) {
159 -      if (error instanceof NotFoundException) {
160 -        throw new NotFoundException(error.message);
161 -      }
162 -
163 -      if (error instanceof ForbiddenException) {
164 -        throw new ForbiddenException(error.message);
165 -      }
166 -
167 -      this.logger.error(\`Failed to delete user \${id}: \${error.message}\`);
168 -      throw new InternalServerErrorException(
169 -        'An error occurred while deleting the user'
170 -      );
171 -    }
172 -  }`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([]);
        });

        it('should handle single line addition', () => {
            const diff = `@@ -10,6 +10,7 @@ export interface Config {
__new hunk__
10    name: string;
11    version: string;
12    description: string;
13 +  author: string;
14    dependencies: {
15      [key: string]: string;
16    };`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 13, end: 13 }, // A single line added
            ]);
        });

        it('should handle consecutive line additions', () => {
            const diff = `@@ -45,6 +45,9 @@ interface PullRequestData {
__new hunk__
45    repository: string;
46    title: string;
47 +  description: string;
48 +  labels: string[];
49 +  status: 'open' | 'closed';
50    created_at: string;
51    updated_at: string;`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 47, end: 49 }, // Three consecutive lines added
            ]);
        });

        it('should handle non-consecutive line additions', () => {
            const diff = `@@ -10,7 +10,9 @@ interface User {
__new hunk__
10    name: string;
11 +  email: string;
12    age: number;
13 +  phone: string;
14    active: boolean;
15 +  role: string;
16    created_at: string;`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 11, end: 11 }, // First line added
                { start: 13, end: 13 }, // Second line added
                { start: 15, end: 15 }, // Third line added
            ]);
        });

        it('should handle new file additions', () => {
            const diff = `@@ -0,0 +1,5 @@
__new hunk__
1 +export interface Config {
2 +  name: string;
3 +  version: string;
4 +  description: string;
5 +}`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 1, end: 5 }, // All lines are new
            ]);
        });

        it('should handle line replacements', () => {
            const diff = `@@ -12,7 +12,7 @@ interface User {
__new hunk__
12    name: string;
13 -  email: string;
14 +  emailAddress: string;
15    age: number;
16    active: boolean;`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 14, end: 14 }, // Only the added line
            ]);
        });

        it('should handle complex file with multiple scattered changes', () => {
            const diff = `@@ -10,7 +10,7 @@ import { DotLoader } from "@components/ui/dot-loader";
__new hunk__
10  import { FormControl } from "@components/ui/form-control";
11  import { Heading } from "@components/ui/heading";
12 -import { SvgKody } from "@components/ui/icons/SvgKody";
13 +import { SvgKody, SvgLogo } from "@components/ui/icons";
14  import { Page } from "@components/ui/page";
15  import { Popover } from "@components/ui/popover";
16  import { useToast } from "@components/ui/toast";

@@ -45,12 +45,14 @@ interface PullRequestData {
__new hunk__
45    repository: string;
46    title: string;
47 +  description: string;
48 +  labels: string[];
49    created_at: string;
50    updated_at: string;
51 -  status: 'open' | 'closed';
52 +  status: 'open' | 'closed' | 'merged';
53    assignees: {
54      id: number;
55      login: string;
56 +    avatar_url: string;
57    }[];
58  }

@@ -98,6 +100,15 @@ export default function PullRequestList() {
__new hunk__
100   const [sortBy, setSortBy] = useState<'created' | 'updated'>('created');
101   const [filterStatus, setFilterStatus] = useState<string[]>([]);
102 +  const [searchQuery, setSearchQuery] = useState('');
103 +
104 +  // Debounce search query
105 +  const debouncedSearch = useDebounce(searchQuery, 300);
106 +
107 +  // Memoize filtered results
108 +  const filteredPRs = useMemo(() => {
109 +    return prs.filter(pr => pr.title.toLowerCase().includes(debouncedSearch.toLowerCase()));
110 +  }, [prs, debouncedSearch]);
111
112    const sortedPRs = useMemo(() => {
113      return [...prs].sort((a, b) => {

@@ -150,9 +161,17 @@ export default function PullRequestList() {
__new hunk__
161                <div className="flex items-center gap-2">
162                  <Avatar
163                    src={assignee.avatar_url}
164 -                  alt={assignee.login}
165 +                  alt={\`\${assignee.login}'s avatar\`}
166                    className="h-6 w-6"
167                  />
168 +                 <Tooltip>
169 +                   <TooltipTrigger>
170 +                     <span className="text-sm text-gray-600">
171 +                       {assignee.login}
172 +                     </span>
173 +                   </TooltipTrigger>
174 +                   <TooltipContent>
175 +                     Click to view profile
176 +                   </TooltipContent>
177 +                 </Tooltip>
178                </div>
179              ))}
180            </div>`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 13, end: 13 }, // Change in the import
                { start: 47, end: 48 }, // Addition of the description and labels fields
                { start: 52, end: 52 }, // Change in the status field
                { start: 56, end: 56 }, // Addition of the avatar_url field
                { start: 102, end: 110 }, // Addition of the search logic
                { start: 165, end: 165 }, // Change in the Avatar alt attribute
                { start: 168, end: 177 }, // Addition of the Tooltip component
            ]);
        });

        // New test cases for indentation and empty lines
        it('should handle indentation changes', () => {
            const diff = `@@ -15,7 +15,7 @@ function calculateTotal() {
__new hunk__
15    const items = [
16 -    { id: 1, price: 10 },
17 +      { id: 1, price: 10 },
18      { id: 2, price: 20 }
19    ];`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 17, end: 17 }, // Line with indentation change
            ]);
        });

        it('should handle empty line additions', () => {
            const diff = `@@ -10,6 +10,8 @@ class User {
__new hunk__
10    constructor() {
11      this.name = '';
12 +
13 +
14      this.email = '';
15    }`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 12, end: 13 }, // Two empty lines added
            ]);
        });

        it('should handle multiple imports addition', () => {
            const diff = `@@ -1,3 +1,7 @@
__new hunk__
1  import { useState } from 'react';
2 +import { useQuery } from '@tanstack/react-query';
3 +import { useDebounce } from '@hooks/useDebounce';
4 +import { Avatar } from '@components/ui/avatar';
5 +import { Button } from '@components/ui/button';
6  import { Input } from '@components/ui/input';`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 2, end: 5 }, // Multiple imports added
            ]);
        });

        it('should handle complex type definition changes', () => {
            const diff = `@@ -10,6 +10,15 @@ type UserPreferences = {
__new hunk__
10    theme: 'light' | 'dark';
11    notifications: boolean;
12 +  dashboard: {
13 +    layout: 'grid' | 'list';
14 +    filters: {
15 +      status: ('active' | 'archived')[];
16 +      priority: ('low' | 'medium' | 'high')[];
17 +      assignee: string[];
18 +    };
19 +    refreshInterval: number;
20 +  };
21    language: string;`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 12, end: 20 }, // Addition of a complex type
            ]);
        });

        it('should handle function parameter changes', () => {
            const diff = `@@ -25,7 +25,7 @@ export class UserService {
__new hunk__
25    async createUser(
26 -    data: CreateUserDto
27 +    data: CreateUserDto & { metadata?: Record<string, unknown>; roles?: string[] }
28    ): Promise<User> {
29      // Implementation
30    }`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 27, end: 27 }, // Change in function parameters
            ]);
        });

        it('should handle JSX component prop changes', () => {
            const diff = `@@ -15,6 +15,13 @@ export function DataTable({ data }) {
__new hunk__
15    return (
16      <Table>
17 +      <Table.Header>
18 +        <Table.Row>
19 +          <Table.HeaderCell sortable onSort={() => {}} sortDirection="asc">
20 +            Name
21 +          </Table.HeaderCell>
22 +        </Table.Row>
23 +      </Table.Header>
24        <Table.Body>
25        </Table.Body>
26    </Table>`;

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 17, end: 23 }, // Addition of a complex JSX component
            ]);
        });

        // Multi-language scenarios
        describe('Multi-language Scenarios', () => {
            describe('Node.js Express API Changes', () => {
                const authMiddlewareDiff = `@@ -10,7 +10,12 @@ const jwt = require('jsonwebtoken');
__new hunk__
10  const express = require('express');
11  const router = express.Router();
12  const User = require('../models/user');
13 +const rateLimit = require('express-rate-limit');
14 +const RedisStore = require('rate-limit-redis');
15
16 -const authenticateToken = async (req, res, next) => {
17 +const limiter = rateLimit({
18 +    store: new RedisStore({ client: redisClient }),
19 +    windowMs: 15 * 60 * 1000,
20 +    max: 100
21 +});
22 +
23 +const authenticateToken = async (req, res, next) => {
24      try {
25          const token = req.header('Authorization')?.replace('Bearer ', '');`;

                const userControllerDiff = `@@ -15,7 +15,12 @@ const User = require('../models/user');
__new hunk__
15  const express = require('express');
16  const router = express.Router();
17  const bcrypt = require('bcryptjs');
18 +const { validationResult } = require('express-validator');
19 +const { body } = require('express-validator');
20 +const logger = require('../utils/logger');
21
22 -const createUser = async (req, res) => {
23 +const createUser = async (req, res, next) => {
24      try {
25          const user = new User(req.body);
26          await user.save();
27 +        logger.info(\`User created: \${user.id}\`);
28          res.status(201).send(user);
29      } catch (error) {
30          res.status(400).send(error);
31      }
32  };`;

                const userModelDiff = `@@ -10,7 +10,12 @@ const mongoose = require('mongoose');
__new hunk__
10  const userSchema = new mongoose.Schema({
11      name: {
12 +        type: String,
13 +        required: true,
14 +        trim: true,
15 +        minlength: 2,
16 +        maxlength: 50
17 +    },
18      email: {
19          type: String,
20          required: true,
21          unique: true,
22          lowercase: true,
23          validate: {
24              validator: function(v) {
25                  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
26              },
27              message: props => \`\${props.value} is not a valid email!\`
28          }
29      },
30      password: {
31          type: String,
32          required: true,
33          minlength: 7
34      }
35  });`;

                it('should handle Node.js authentication middleware changes', () => {
                    const result = extractLinesFromDiffHunk(authMiddlewareDiff);
                    expect(result).toEqual([
                        { start: 13, end: 14 }, // New imports
                        { start: 17, end: 23 }, // Rate limiting and logging
                    ]);
                });

                it('should handle Node.js controller changes', () => {
                    const result = extractLinesFromDiffHunk(userControllerDiff);
                    expect(result).toEqual([
                        { start: 18, end: 20 }, // New imports
                        { start: 23, end: 23 }, // Addition of next
                        { start: 27, end: 27 }, // Error logging
                    ]);
                });

                it('should handle Node.js model changes', () => {
                    const result = extractLinesFromDiffHunk(userModelDiff);
                    expect(result).toEqual([
                        { start: 12, end: 17 }, // New fields and validations
                    ]);
                });
            });

            describe('Python Django API Changes', () => {
                const viewsDiff = `@@ -15,7 +15,12 @@ from django.db import models
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

                const modelsDiff = `@@ -25,8 +25,15 @@ class User(models.Model):
__new hunk__
25      email = models.EmailField(unique=True)
26      username = models.CharField(max_length=100)
27 +    first_name = models.CharField(max_length=50)
28 +    last_name = models.CharField(max_length=50)
29 +    is_active = models.BooleanField(default=True)
30      created_at = models.DateTimeField(auto_now_add=True)
31      updated_at = models.DateTimeField(auto_now=True)`;

                const serializersDiff = `@@ -30,12 +30,25 @@ class UserSerializer(serializers.ModelSerializer):
__new hunk__
30      class Meta:
31          model = User
32 +        fields = ('id', 'email', 'username', 'first_name', 'last_name')
33 +        read_only_fields = ('created_at', 'updated_at')
34
35 -    def validate_email(self, value):
36 -        if User.objects.filter(email=value).exists():
37 -            raise serializers.ValidationError("Email already exists")
38 -        return value
39 +    def validate(self, attrs):
40 +        if attrs.get('password'):
41 +            attrs['password'] = make_password(attrs['password'])
42 +        return attrs`;

                it('should handle Python view changes', () => {
                    const result = extractLinesFromDiffHunk(viewsDiff);
                    expect(result).toEqual([
                        { start: 17, end: 19 }, // Import of permissions
                        { start: 22, end: 24 }, // Custom validation
                        { start: 27, end: 27 }, // Cache configuration
                    ]);
                });

                it('should handle Python model changes', () => {
                    const result = extractLinesFromDiffHunk(modelsDiff);
                    expect(result).toEqual([
                        { start: 27, end: 29 }, // New fields and validations
                    ]);
                });

                it('should handle Python serializer changes', () => {
                    const result = extractLinesFromDiffHunk(serializersDiff);
                    expect(result).toEqual([
                        { start: 32, end: 33 }, // New fields
                        { start: 39, end: 42 }, // Validation
                    ]);
                });
            });

            describe('Java Spring API Changes', () => {
                const controllerDiff = `@@ -30,12 +30,25 @@ import org.springframework.web.bind.annotation.*;
__new hunk__
30  @RestController
31  @RequestMapping("/api/orders")
32 +@Slf4j
33 +@CacheConfig(cacheNames = "orders")
34  public class OrderController {
35      private final OrderService orderService;
36 +    private final OrderMapper orderMapper;
37 +    private final ApplicationEventPublisher eventPublisher;
38
39 -    public OrderDTO findById(Long id) {
40 -        return orderService.findById(id);
41 +    @Cacheable(key = "#id")
42 +    @Transactional(readOnly = true)
43 +    public OrderDTO findById(Long id) {
44 +        log.debug("Request to get Order : {}", id);
45 +        return orderService.findById(id);
46      }`;

                const serviceDiff = `@@ -25,8 +25,15 @@ import org.springframework.stereotype.Service;
__new hunk__
25      @Autowired
26      private OrderRepository orderRepository;
27 +    @Autowired
28 +    private OrderMapper orderMapper;
29 +    @Autowired
30 +    private ApplicationEventPublisher eventPublisher;
31
32 -    public OrderDTO findById(Long id) {
33 -        return orderRepository.findById(id)
34 -            .map(this::toDTO)
35 -            .orElseThrow(() -> new ResourceNotFoundException("Order not found"));
36 +    @Cacheable(key = "#id")
37 +    @Transactional(readOnly = true)
38 +    public OrderDTO findById(Long id) {
39 +        log.debug("Request to get Order : {}", id);
40 +        return orderRepository.findById(id)
41 +            .map(orderMapper::toDto)
42 +            .orElseThrow(() -> new ResourceNotFoundException("Order not found"));
43      }`;

                const repositoryDiff = `@@ -15,7 +15,12 @@ import org.springframework.data.jpa.repository.JpaRepository;
__new hunk__
15  @Repository
16  public interface OrderRepository extends JpaRepository<Order, Long> {
17 +    @Query("SELECT o FROM Order o WHERE o.user.id = :userId")
18 +    List<Order> findByUserId(@Param("userId") Long userId);
19 +
20 +    @Query("SELECT o FROM Order o WHERE o.total >= :minAmount")
21 +    List<Order> findByMinAmount(
22 +        @Param("minAmount") BigDecimal minAmount);
23  }`;

                it('should handle Java controller changes', () => {
                    const result = extractLinesFromDiffHunk(controllerDiff);
                    expect(result).toEqual([
                        { start: 32, end: 33 }, // Security
                        { start: 36, end: 37 }, // Dependency injection
                        { start: 41, end: 45 }, // Response handling
                    ]);
                });

                it('should handle Java service changes', () => {
                    const result = extractLinesFromDiffHunk(serviceDiff);
                    expect(result).toEqual([
                        { start: 27, end: 30 }, // Constructor injection
                        { start: 36, end: 42 }, // Retry and logging
                    ]);
                });

                it('should handle Java repository changes', () => {
                    const result = extractLinesFromDiffHunk(repositoryDiff);
                    expect(result).toEqual([
                        { start: 17, end: 22 }, // Query methods and locks
                    ]);
                });
            });

            describe('Go API Changes', () => {
                const handlerDiff = `@@ -25,8 +25,15 @@ import (
__new hunk__
25      "context"
26      "net/http"
27 +    "github.com/go-playground/validator/v10"
28 +    "github.com/opentracing/opentracing-go"
29 +    "github.com/prometheus/client_golang/prometheus"
30  )
31
32 +func (h *Handler) CreateOrder(w http.ResponseWriter, r *http.Request) {
33 +    span, ctx := opentracing.StartSpanFromContext(r.Context(), "Handler.CreateOrder")
34 +    defer span.Finish()
35 +
36 +    var order Order
37 +    if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
38 +        h.errorResponse(w, r, err)
39 +        return
40 +    }
41 +}`;

                const serviceDiff = `@@ -30,12 +30,25 @@ type OrderService struct {
__new hunk__
30      repo  Repository
31      cache Cache
32 +    logger Logger
33 +    metrics Metrics
34  }
35
36 -func (s *OrderService) Create(ctx context.Context, order *Order) error {
37 -    return s.repo.Create(ctx, order)
38 +func (s *OrderService) Create(ctx context.Context, order *Order) error {
39 +    span, ctx := opentracing.StartSpanFromContext(ctx, "OrderService.Create")
40 +    defer span.Finish()
41 +
42 +    if err := s.validate(order); err != nil {
43 +        return fmt.Errorf("validate order: %w", err)
44 +    }
45 +
46 +    if err := s.repo.Create(ctx, order); err != nil {
47 +        return fmt.Errorf("create order: %w", err)
48 +    }
49 +
50 +    return nil
51  }`;

                const modelDiff = `@@ -20,8 +20,15 @@ type Order struct {
__new hunk__
20      ID        string    \`json:"id" validate:"required"\`
21      UserID    string    \`json:"user_id" validate:"required"\`
22 +    Status    string    \`json:"status" validate:"required,oneof=pending processing completed"\`
23 +    Items     []Item    \`json:"items" validate:"required,min=1,dive"\`
24 +    Total     float64   \`json:"total" validate:"required,gt=0"\`
25      CreatedAt time.Time \`json:"created_at"\`
26      UpdatedAt time.Time \`json:"updated_at"\`
27 +
28 +    // Internal fields
29 +    Version   int       \`json:"-"\`
30 +    DeletedAt *time.Time \`json:"-"\`
31  }`;

                it('should handle Go handler changes', () => {
                    const result = extractLinesFromDiffHunk(handlerDiff);
                    expect(result).toEqual([
                        { start: 27, end: 29 }, // Imports
                        { start: 32, end: 41 }, // Handler setup and error handling
                    ]);
                });

                it('should handle Go service changes', () => {
                    const result = extractLinesFromDiffHunk(serviceDiff);
                    expect(result).toEqual([
                        { start: 32, end: 33 }, // Logger setup
                        { start: 38, end: 50 }, // Service methods
                    ]);
                });

                it('should handle Go model changes', () => {
                    const result = extractLinesFromDiffHunk(modelDiff);
                    expect(result).toEqual([
                        { start: 22, end: 24 }, // Struct fields
                        { start: 27, end: 30 }, // Model methods
                    ]);
                });
            });
        });

        it('should handle new React component creation', () => {
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

            const result = extractLinesFromDiffHunk(diff);
            expect(result).toEqual([
                { start: 1, end: 107 }, // The entire file is new
            ]);
        });
    });
});
