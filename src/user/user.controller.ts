// src/user/user.controller.ts v2
import {
  Controller,
  Get,
  Post,
  Body,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { UserService } from './user.service';
import { UpsertUserDto } from './dto/upsert-user.dto';
import { InitDataService } from '../utils/init-data.service';

@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly initDataService: InitDataService,
  ) {}

  @Get()
  findAll() {
    return this.userService.findAll();
  }

  @Post('init')
  async init(@Body() body: { initData: string }) {
    const isValid = this.initDataService.validateInitData(body.initData);

    if (!isValid) {
      throw new UnauthorizedException('Invalid initData');
    }

    const { user } = this.initDataService.parseInitData(body.initData);

    if (!user) {
      throw new BadRequestException('Missing "user" field in initData');
    }

    const {
      id,
      first_name: firstName,
      last_name: lastName = '',
      username: userName = '',
    } = user;

    return this.userService.upsertUser({
      telegramId: id.toString(),
      firstName,
      lastName,
      userName,
    });
  }
}
