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
    private readonly httpService: HttpService
  ) {}

  async createLobby(initData: InitDataParsed) {
    const telegramId = initData.user?.id;
    const firstName = initData.user?.first_name || 'Игрок';

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

    console.log('✅ Lobby successfully created in Redis');
    console.log('📦 Lobby saved in memory');
    console.log('📢 Lobby ready event emitted');

    return { lobbyId, inviteUrl };
  }

  async createInvite(tgId: string) {
    console.log('🔍 Creating invite for telegramId:', tgId);
    const user = await this.prisma.user.findUnique({ where: { telegramId: tgId.toString() } });
    const firstName = user?.firstName || "Gamer";

    const keys = await this.redis.keys('lobby_*');
    console.log('📋 Found Redis keys:', keys);
    let lobbyId: string | null = null;

    for (const key of keys) {
      const value = await this.redis.get(key);
      if (!value) continue;
      
      console.log(`🔑 Checking lobby ${key}:`, {
        value,
        expectedTgId: tgId.toString()
      });
      
      try {
        const lobbyData = JSON.parse(value);
        console.log('📦 Parsed lobby data:', {
          creatorId: lobbyData.creatorId,
          matches: lobbyData.creatorId === tgId.toString()
        });
        
        if (lobbyData.creatorId === tgId.toString()) {
          lobbyId = key;
          break;
        }
      } catch (error) {
        console.error('❌ Error parsing lobby data:', error);
      }
    }

    if (!lobbyId) {
      console.log('❌ No matching lobby found for telegramId:', tgId);
      throw new ForbiddenException('Lobby not found');
    }

    console.log('✅ Found lobby:', lobbyId);

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
            url: `https://t.me/TacTicToe_bot?startapp=${lobbyId}`
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
    return { messageId: data.result.id, lobbyId };
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
    const ownerTgId = await this.redis.get(lobbyId);
    if (!ownerTgId) {
      throw new NotFoundException('Lobby not found');
    }
    if (ownerTgId === tgId.toString()) {
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
