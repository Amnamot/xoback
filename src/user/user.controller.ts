// user.controller.ts
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

    const parsed = this.initDataService.parseInitData(body.initData);
    const userObj = parsed.user;

    if (!userObj) {
      throw new BadRequestException('Missing "user" field in initData');
    }

    return this.userService.upsertUser({
      telegramId: userObj.id.toString(),
      firstName: userObj.first_name,
      lastName: userObj.last_name ?? '',
      userName: userObj.username ?? '',
    });
  }
}
