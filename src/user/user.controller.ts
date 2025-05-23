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

    // 2. Проверяем существование лобби
    const lobbyKey = `lobby:${id}`;
    let lobbyData = null;
    try {
      const existingLobby = await this.redis.get(lobbyKey);
      if (existingLobby) {
        lobbyData = JSON.parse(existingLobby);
      }
    } catch (e) {
      console.error('Error checking lobby:', e);
    }

    // 3. Формируем ответ
    const response = {
      ...dbUser,
      lobby: lobbyData ? {
        lobbyId: lobbyData.id,
        status: lobbyData.status
      } : null
    };

    // 4. Логируем ответ
    console.log('📝 [UserController] /user/init response:', {
      telegramId: id,
      userData: {
        firstName,
        lastName,
        userName,
        avatar
      },
      dbUser,
      lobby: response.lobby,
      timestamp: new Date().toISOString()
    });

    return response;
  }
}
