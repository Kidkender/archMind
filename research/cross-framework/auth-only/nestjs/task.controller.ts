import { Controller, Get, Param, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from './jwt-auth.guard'

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TaskController {
  @Get(':id')
  show(@Param('id') id: string) {
    return { id }
  }
}
