// src/lobby/lobby.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { InitDataService } from '../utils/init-data.service';
import { nanoid } from 'nanoid';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class LobbyService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly initDataService: InitDataService,
    private readonly configService: ConfigService,
  ) {}

  async createLobby(initData: string) {
    const botToken = this.configService.get<string>('BOT_TOKEN');
    if (!botToken) {
      throw new Error('BOT_TOKEN is not defined');
    }

    if (!this.initDataService.validateInitData(initData, botToken)) {
      throw new Error('Invalid initData');
    }

    const parsed = this.initDataService.parseInitData(initData);
    const user = parsed.user;
    if (!user) {
      throw new Error('No user in initData');
    }

    const lobbyId = nanoid(8);
    const lobbyData = {
      user: {
        id: user.id,
        firstName: user.firstName,
      },
    };

    await this.redis.setex(`lobby:${lobbyId}`, 180, JSON.stringify(lobbyData)); // TTL 3 минуты

    const inviteLink = `https://t.me/TacTicToe_bot/game?startapp=invite_${lobbyId}`;

    console.log('📨 Sending invite to Telegram:', {
      chat_id: user.id,
      firstName: user.firstName,
      inviteLink,
    });

    await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      chat_id: user.id,
      photo: 'https://igra.top/media/invite.jpg',
      caption: `🎯 *${user.firstName}*, пригласил тебя сыграть партию!\n\nЖми на кнопку ниже, чтобы присоединиться.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Присоединиться',
              url: inviteLink,
            },
          ],
        ],
      },
    });

    return { lobbyId, inviteLink };
  }
}
