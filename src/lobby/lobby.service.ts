import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import axios from 'axios';

@Injectable()
export class LobbyService {
  private readonly redis = new Redis(process.env.REDIS_URL!);
  private readonly logger = new Logger(LobbyService.name);

  async createLobby(user: any): Promise<{ lobbyId: string }> {
    const lobbyId = randomUUID();

    const lobbyData = {
      createdAt: Date.now(),
      inviterId: user.id,
      inviterName: user.first_name,
      status: 'waiting',
    };

    await this.redis.setex(`lobby:${lobbyId}`, 180, JSON.stringify(lobbyData)); // 3 минуты

    await this.sendTelegramInvite(user, lobbyId);

    return { lobbyId };
  }

  private async sendTelegramInvite(user: any, lobbyId: string) {
    const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`;

    const payload = {
      chat_id: user.id,
      photo: 'https://igra.top/media/invite.jpg',
      caption: `🕹 ${user.first_name} приглашает тебя на игру!`,
      reply_markup: {
        inline_keyboard: [[
          {
            text: 'Присоединиться к игре',
            url: `https://t.me/TacTicToe_bot/game?startapp=${lobbyId}`
          }
        ]]
      }
    };

    try {
      await axios.post(url, payload);
    } catch (error) {
      this.logger.error('Failed to send Telegram invite', error?.response?.data || error.message);
    }
  }
}
