import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Redis } from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { InitDataService } from '../utils/init-data.service';
import axios from 'axios';

@Injectable()
export class LobbyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
    private readonly initDataService: InitDataService,
  ) {}

  async createLobby(initData: string) {
    const parsed = this.initDataService.parseInitData(initData);
    const telegramId = parsed.user?.id?.toString();
    if (!telegramId) throw new Error('Telegram ID not found in initData');

    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new Error('User not found');

    const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await this.redis.set(lobbyId, telegramId, 'EX', 180); // 3 минуты

    const botToken = this.configService.get<string>('BOT_TOKEN');
    const channelId = this.configService.get<string>('INVITE_CHANNEL_ID');
    const inviteLink = `https://t.me/TacTicToe_bot?startapp=${lobbyId}`;

    return { lobbyId, inviteLink };
  }
}
