// src/lobby/lobby.service.ts v10
import { Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { InitDataParsed } from '../utils/init-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { randomBytes } from 'crypto';
import axios from 'axios';

interface TelegramPreparedMessageResponse {
  ok: boolean;
  result?: {
    msg_id: string;
  };
  description?: string;
}

@Injectable()
export class LobbyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async createLobby(initData: InitDataParsed) {
    const telegramId = initData.user?.id;
    const firstName = initData.user?.first_name || 'Игрок';
    const username = initData.user?.username || 'player';

    if (!telegramId) {
      throw new UnauthorizedException('Invalid Telegram ID');
    }

    const user = await this.prisma.user.findUnique({
      where: { telegramId: telegramId.toString() },
    });

    if (!user) throw new NotFoundException("User not found");

    const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await this.redis.set(lobbyId, telegramId.toString(), 'EX', 180);

    const inviteUrl = `https://t.me/TacTicToe_bot?startapp=${lobbyId}`;
    const BOT_TOKEN = this.configService.get<string>('BOT_TOKEN');
    const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/savePreparedInlineMessage`;

    const result = {
      type: "article",
      id: randomBytes(5).toString("hex"),
      title: "Приглашение в игру! 🎮",
      input_message_content: {
        message_text: `🎲 ${firstName} вызывает тебя на дуэль в TacTicToe!\n\nНажми кнопку ниже, чтобы принять вызов.`,
      },
      reply_markup: {
        inline_keyboard: [[
          {
            text: "Принять вызов 🚀",
            url: inviteUrl
          }
        ]]
      },
      thumbnail_url: "https://igra.top/media/inviteImg.png",
      thumbnail_width: 300,
      thumbnail_height: 300,
    };

    const url = `${API_URL}?user_id=${telegramId}&result=${encodeURIComponent(JSON.stringify(result))}&allow_user_chats=true&allow_group_chats=true`;

    const response = await axios.get<TelegramPreparedMessageResponse>(url);
    console.log("📦 Ответ от Telegram:", JSON.stringify(response.data, null, 2));

    if (response.data.ok && response.data.result) {
      return { lobbyId, inviteUrl, messageId: response.data.result.msg_id };
    } else {
      throw new Error(response.data.description || "Ошибка при создании приглашения");
    }
  }
}
