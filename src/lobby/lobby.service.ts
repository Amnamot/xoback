import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Redis } from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import axios from 'axios';

@Injectable()
export class LobbyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async createLobby(tgId: string) {
    const user = await this.prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user) throw new Error('User not found');

    const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await this.redis.set(lobbyId, tgId, 'EX', 180); // 3 минуты

    const botToken = this.configService.get<string>('BOT_TOKEN');
    const channelId = this.configService.get<string>('INVITE_CHANNEL_ID');
    const inviteLink = `https://t.me/TacTicToe_bot?startapp=${lobbyId}`;

    if (!botToken || !channelId) {
      throw new Error('BOT_TOKEN or INVITE_CHANNEL_ID not set');
    }

    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        chat_id: channelId,
        photo: 'https://igra.top/media/invite.jpg',
        caption: `🎯 *${user.firstName}*, пригласил тебя сыграть партию!\n\nЖми на кнопку ниже, чтобы присоединиться.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: 'Присоединиться', url: inviteLink }]],
        },
      });
    } catch (err) {
      console.error('❌ Telegram API sendPhoto error:', err.response?.data || err.message);
      throw new Error('Telegram API sendPhoto failed');
    }

    return { lobbyId };
  }
}
