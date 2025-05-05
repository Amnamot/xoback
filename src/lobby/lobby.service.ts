// src/lobby/lobby.service.ts v7
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InitDataParsed } from '../utils/init-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
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

  async createLobby(initData: InitDataParsed) {
    const telegramId = initData.user?.id?.toString();
    const firstName = initData.user?.first_name || 'Игрок';

    if (!telegramId) {
      throw new UnauthorizedException('Invalid Telegram ID');
    }

    const user = await this.prisma.user.findUnique({
      where: { telegramId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await this.redis.set(lobbyId, telegramId, 'EX', 180);

    const inviteLink = `https://t.me/TacTicToe_bot?startapp=${lobbyId}`;
    const botToken = this.configService.get<string>('BOT_TOKEN');
    const imageUrl = 'https://igra.top/media/inviteImg.png';

    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/savePreparedInlineMessage`,
      {
        result: {
          type: 'article',
          id: lobbyId,
          title: `${firstName} вызывает на поединок`,
          input_message_content: {
            message_text: `${firstName} вызывает тебя на поединок в TacTicToe!\n\nНажми кнопку ниже, чтобы принять вызов.`,
          },
          reply_markup: {
            inline_keyboard: [[
              {
                text: 'Принять вызов',
                url: inviteLink,
              }
            ]]
          },
          thumbnail_url: imageUrl,
        }
      }
    );

    console.log('📦 Ответ Telegram (prepared):', JSON.stringify(response.data, null, 2));

    const messageId = (response.data as any)?.result?.message_id;

    return { lobbyId, inviteLink, messageId };
  }
}
