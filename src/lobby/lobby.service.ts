// lobby.service.ts
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
    const isValid = this.initDataService.validateInitData(initData);
    if (!isValid) {
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
        firstName: user.first_name,
      },
    };

    await this.redis.setex(`lobby:${lobbyId}`, 180, JSON.stringify(lobbyData));

    const inviteLink = `https://t.me/TacTicToe_bot/game?startapp=invite_${lobbyId}`;
    const channelId = this.configService.get<string>('INVITE_CHANNEL_ID'); // ✅ добавлено

    await axios.post(`https://api.telegram.org/bot${this.configService.get<string>('BOT_TOKEN')}/sendPhoto`, {
      chat_id: channelId, // ✅ заменено
      photo: 'https://igra.top/media/invite.jpg',
      caption: `🎯 *${user.first_name}*, пригласил тебя сыграть партию!\n\nЖми на кнопку ниже, чтобы присоединиться.`,
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
