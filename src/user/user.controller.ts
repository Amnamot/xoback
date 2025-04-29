// user.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { UserService } from './user.service';
import { ApiTags, ApiBody, ApiResponse } from '@nestjs/swagger';

@ApiTags('User')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('init')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        telegramId: { type: 'string' },
        userName: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
      },
      required: ['telegramId', 'firstName'],
    },
  })
  @ApiResponse({ status: 200, description: 'User created or updated' })
  async initUser(@Body() body: {
    telegramId: string;
    userName: string;
    firstName: string;
    lastName: string;
  }) {
    return this.userService.createOrUpdateUser(body);
  }
}
