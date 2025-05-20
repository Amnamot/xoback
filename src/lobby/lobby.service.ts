// src/lobby/lobby.service.ts v22
import { Injectable, UnauthorizedException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InitDataParsed } from '../utils/init-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { randomBytes } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { GameService } from '../game/game.service';

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
    private readonly httpService: HttpService,
    private readonly gameService: GameService
  ) {}

  async createInvite(tgId: string) {
    console.log('🔍 Creating invite for telegramId:', tgId);
    const user = await this.prisma.user.findUnique({ where: { telegramId: tgId.toString() } });
    const firstName = user?.firstName || "Gamer";

    // Ищем лобби через GameService
    const lobby = await this.gameService.findLobbyByCreator(tgId.toString());
    if (!lobby) {
      console.log('❌ No matching lobby found for telegramId:', tgId);
      throw new ForbiddenException('Lobby not found');
    }

    console.log('✅ Found lobby:', lobby.id);

    const result = {
      type: "article",
      id: randomBytes(5).toString("hex"),
      title: "Invitation to the game!",
      description: "Click to accept the call!",
      input_message_content: {
        message_text: `❌ Invitation to the game ⭕️\n\n${firstName} invites you\nto fight in endless TicTacToe`,
      },
      reply_markup: {
        inline_keyboard: [[
          {
            text: "⚔️ Accept the battle 🛡",
            url: `https://t.me/TacTicToe_bot?startapp=${lobby.id}`
          }
        ]]
      },
      thumbnail_url: "https://igra.top/media/inviteImg.png",
      thumbnail_width: 300,
      thumbnail_height: 300,
    };

    const BOT_TOKEN = this.configService.get("BOT_TOKEN");
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/savePreparedInlineMessage`;
    const url = `${apiUrl}?user_id=${tgId}&result=${encodeURIComponent(JSON.stringify(result))}&allow_user_chats=true&allow_group_chats=true`;

    const { data }: any = await firstValueFrom(this.httpService.get(url));
    return { messageId: data.result.id, lobbyId: lobby.id };
  }

  async cancelLobbyPublic(lobbyId: string, telegramId: string) {
    const value = await this.redis.get(lobbyId);
    if (value && value === telegramId) {
      await this.redis.del(lobbyId);
      return { success: true };
    }
    throw new NotFoundException('Lobby not found or unauthorized');
  }

  async joinLobby(tgId: string, lobbyId: string) {
    const lobby = await this.gameService.getLobby(lobbyId);
    if (!lobby) {
      throw new NotFoundException('Lobby not found');
    }
    if (lobby.creatorId === tgId.toString()) {
      return { status: 'creator' };
    }
    return { success: true };
  }

  async getTimeLeft(tgId: string) {
    const keys = await this.redis.keys('lobby_*');
    for (const key of keys) {
      const value = await this.redis.get(key);
      if (value === tgId.toString()) {
        const ttl = await this.redis.ttl(key);
        return { timeLeft: ttl };
      }
    }
    throw new NotFoundException('Lobby not found');
  }
}
