// @ts-nocheck
// NestJS fixture — no @nestjs/* packages needed; ts-morph parses syntax only

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserController {

  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne(@Param('id') id: string) { return null; }

  // Multiple guards + @Roles metadata
  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateUserDto) { return null; }

  // Two guards in one @UseGuards call
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'superadmin')
  remove(@Param('id') id: string) { return null; }

  // @Public() suppresses controller-level JwtAuthGuard
  @Get('health')
  @Public()
  health() { return { ok: true }; }

  // Local @UsePipes
  @Put(':id')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) { return null; }
}
