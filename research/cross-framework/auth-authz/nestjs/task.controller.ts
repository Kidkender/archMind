import { Controller, Put, Param, Body, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from './jwt-auth.guard'
import { RolesGuard } from './roles.guard'
import { Roles } from './roles.decorator'

@Controller('tasks')
export class TaskController {
  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('editor')
  update(@Param('id') id: string, @Body() body: unknown) {
    return { id }
  }
}
