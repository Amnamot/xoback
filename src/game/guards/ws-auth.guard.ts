import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class WsAuthGuard implements CanActivate {
  private readonly logger = new Logger(WsAuthGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const client: Socket = context.switchToWs().getClient();
      const telegramId = client.handshake.query.telegramId as string;

      if (!telegramId) {
        throw new WsException('Unauthorized - Missing telegramId');
      }

      // Проверяем существование пользователя
      const user = await this.prisma.user.findUnique({
        where: { telegramId }
      });

      if (!user) {
        throw new WsException('Unauthorized - User not found');
      }

      // Добавляем данные пользователя в сокет
      (client as any).telegramId = telegramId;
      (client as any).firstName = user.firstName;
      (client as any).userName = user.userName;

      return true;
    } catch (error) {
      this.logger.error({
        event: 'wsAuthError',
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw new WsException('Unauthorized');
    }
  }
} 