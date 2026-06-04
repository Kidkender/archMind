import { Controller, Post, Body, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common'
import { JwtAuthGuard } from './jwt-auth.guard'
import { CreateTaskDto } from './create-task.dto'

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TaskController {
  @Post()
  @UsePipes(new ValidationPipe())
  store(@Body() dto: CreateTaskDto) {
    return { created: true }
  }
}
