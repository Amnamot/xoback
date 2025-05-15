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
import { Logger } from '@nestjs/common';

interface TelegramPreparedMessageResponse {
  ok: boolean;
  result?: {
    msg_id: string;
  };
  description?: string;
}

@Injectable()
export class LobbyService {
  private readonly logger = new Logger('LobbyService');

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.logger.log('LobbyService initialized');
  }

  async createInvite(tgId: string) {
    this.logger.log({
      event: 'createInviteStarted',
      telegramId: tgId,
      timestamp: new Date().toISOString()
    });

    const user = await this.prisma.user.findUnique({ where: { telegramId: tgId.toString() } });
    const firstName = user?.firstName || "Gamer";

    const keys = await this.redis.keys('lobby_*');
    this.logger.debug({
      event: 'searchingExistingLobbies',
      foundKeys: keys.length,
      telegramId: tgId
    });

    let lobbyId: string | null = null;

    for (const key of keys) {
      const value = await this.redis.get(key);
      if (!value) continue;
      
      try {
        const lobbyData = JSON.parse(value);
        if (lobbyData.creatorId === tgId.toString()) {
          lobbyId = key;
          this.logger.debug({
            event: 'existingLobbyFound',
            lobbyId: key,
            telegramId: tgId
          });
          break;
        }
      } catch (error) {
        this.logger.error({
          event: 'lobbyDataParseError',
          error: error.message,
          key,
          telegramId: tgId
        });
      }
    }

    if (!lobbyId) {
      this.logger.warn({
        event: 'lobbyNotFound',
        telegramId: tgId
      });
      throw new ForbiddenException('Lobby not found');
    }

    this.logger.log({
      event: 'creatingInviteMessage',
      lobbyId,
      telegramId: tgId,
      firstName
    });

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

    try {
      const maxRetries = 3;
      let retryCount = 0;
      let lastError = null;

      while (retryCount < maxRetries) {
        try {
          const { data }: any = await firstValueFrom(
            this.httpService.get(url, { 
              timeout: 5000,
              headers: {
                'User-Agent': 'TicTacToe-Bot/1.0'
              }
            })
          );

          this.logger.log({
            event: 'inviteCreated',
            lobbyId,
            telegramId: tgId,
            messageId: data.result.id,
            attempt: retryCount + 1
          });

          return { messageId: data.result.id, lobbyId };
        } catch (error) {
          lastError = error;
          retryCount++;
          
          this.logger.warn({
            event: 'inviteCreationRetryFailed',
            attempt: retryCount,
            maxRetries,
            error: error.message,
            code: error.code,
            lobbyId,
            telegramId: tgId
          });

          if (retryCount < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
          }
        }
      }

      this.logger.error({
        event: 'inviteCreationAllRetriesFailed',
        error: lastError?.message,
        lobbyId,
        telegramId: tgId
      });
      throw new Error('Failed to create invite after all retries');
    } catch (error) {
      this.logger.error({
        event: 'inviteCreationError',
        error: error.message,
        lobbyId,
        telegramId: tgId
      });
      throw error;
    }
  }

  async cancelLobbyPublic(lobbyId: string, telegramId: string) {
    this.logger.log({
      event: 'cancelLobbyStarted',
      lobbyId,
      telegramId
    });

    const value = await this.redis.get(lobbyId);
    if (value && value === telegramId) {
      await this.redis.del(lobbyId);
      this.logger.log({
        event: 'lobbyCancelled',
        lobbyId,
        telegramId
      });
      return { success: true };
    }

    this.logger.warn({
      event: 'cancelLobbyFailed',
      reason: 'notFoundOrUnauthorized',
      lobbyId,
      telegramId
    });
    throw new NotFoundException('Lobby not found or unauthorized');
  }

  async joinLobby(tgId: string, lobbyId: string) {
    this.logger.log({
      event: 'joinLobbyStarted',
      lobbyId,
      telegramId: tgId
    });

    const ownerTgId = await this.redis.get(lobbyId);
    if (!ownerTgId) {
      this.logger.warn({
        event: 'joinLobbyFailed',
        reason: 'lobbyNotFound',
        lobbyId,
        telegramId: tgId
      });
      throw new NotFoundException('Lobby not found');
    }

    if (ownerTgId === tgId.toString()) {
      this.logger.log({
        event: 'joinLobbyCreator',
        lobbyId,
        telegramId: tgId
      });
      return { status: 'creator' };
    }

    this.logger.log({
      event: 'joinLobbySuccess',
      lobbyId,
      telegramId: tgId,
      creatorId: ownerTgId
    });
    return { success: true };
  }

  async getTimeLeft(tgId: string) {
    this.logger.debug({
      event: 'getTimeLeftStarted',
      telegramId: tgId
    });

    const keys = await this.redis.keys('lobby_*');
    for (const key of keys) {
      const value = await this.redis.get(key);
      if (value === tgId.toString()) {
        const ttl = await this.redis.ttl(key);
        this.logger.debug({
          event: 'timeLeftFound',
          lobbyId: key,
          telegramId: tgId,
          ttl
        });
        return { ttl };
      }
    }

    this.logger.debug({
      event: 'timeLeftNotFound',
      telegramId: tgId
    });
    return { ttl: 0 };
  }

  async getLobbyTTL(lobbyId: string): Promise<number> {
    this.logger.debug({
      event: 'getLobbyTTLStarted',
      lobbyId
    });

    try {
      const ttl = await this.redis.ttl(lobbyId);
      this.logger.debug({
        event: 'lobbyTTLFound',
        lobbyId,
        ttl: ttl > 0 ? ttl : 180
      });
      return ttl > 0 ? ttl : 180;
    } catch (error) {
      this.logger.error({
        event: 'getLobbyTTLError',
        error: error.message,
        lobbyId
      });
      return 180;
    }
  }

  async findLobbyByCreator(telegramId: string) {
    this.logger.debug({
      event: 'findLobbyByCreatorStarted',
      telegramId
    });

    const keys = await this.redis.keys('lobby_*');
    
    for (const key of keys) {
      const value = await this.redis.get(key);
      if (!value) continue;
      
      try {
        if (value === telegramId.toString()) {
          this.logger.debug({
            event: 'lobbyFoundByCreator',
            lobbyId: key,
            telegramId
          });
          return {
            id: key,
            status: 'active'
          };
        }
      } catch (error) {
        this.logger.error({
          event: 'findLobbyByCreatorError',
          error: error.message,
          key,
          telegramId
        });
      }
    }
    
    this.logger.debug({
      event: 'lobbyNotFoundByCreator',
      telegramId
    });
    return null;
  }
}
