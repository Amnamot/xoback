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
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly initDataService: InitDataService,
    @InjectRedis() private readonly redis: Redis
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
      photo_url: avatar = '',
    } = user;

    // 1. Сохраняем пользователя в БД
    const dbUser = await this.userService.upsertUser({
      telegramId: id.toString(),
      firstName,
      lastName,
      userName
    });

    // 2. Обновляем Redis
    const redisKey = `player:${id}`;
    let playerData: any = {};
    try {
      const existing = await this.redis.get(redisKey);
      if (existing) {
        playerData = JSON.parse(existing);
      }
    } catch (e) {
      playerData = {};
    }
    playerData.name = firstName;
    playerData.avatar = avatar;
    await this.redis.set(redisKey, JSON.stringify(playerData), 'EX', 180);

    return dbUser;
  }
}
