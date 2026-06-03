// @ts-nocheck
// No explicit guards — relies entirely on global APP_GUARD from AppModule

@Controller('posts')
export class PostsController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne(@Param('id') id: string) { return null; }

  @Post()
  create(@Body() dto: CreatePostDto) { return null; }

  // @Public() suppresses even the global APP_GUARD
  @Get('public-stats')
  @Public()
  publicStats() { return {}; }
}
