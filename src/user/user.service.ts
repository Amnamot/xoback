// src/user/user.service.ts v1
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Logger } from '@nestjs/common';
import { UpsertUserDto } from './dto/upsert-user.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger('UserService');

  constructor(private readonly prisma: PrismaService) {
    this.logger.log('UserService initialized');
  }

  findAll() {
    return this.prisma.user.findMany();
  }

  generateXoId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 8 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  }

  async upsertUser(dto: UpsertUserDto) {
    // Генерация уникального xoId
    let xoId: string;
    while (true) {
      const candidate = this.generateXoId();
      const existing = await this.prisma.user.findUnique({
        where: { xoId: candidate },
      });
      if (!existing) {
        xoId = candidate;
        break;
      }
    }

    // Проверка, существует ли пользователь
    const existingUser = await this.prisma.user.findUnique({
      where: { telegramId: dto.telegramId },
    });

    if (existingUser) {
      // Обновляем только определённые поля + lastVisit
      await this.prisma.user.update({
        where: { telegramId: dto.telegramId },
        data: {
          firstName: dto.firstName ?? '',
          lastName: dto.lastName ?? '',
          userName: dto.userName ?? '',
          lastVisit: new Date(),
        },
      });
    } else {
      // Создаём нового пользователя со всеми начальными значениями
      await this.prisma.user.create({
        data: {
          telegramId: dto.telegramId ?? '',
          firstName: dto.firstName ?? '',
          lastName: dto.lastName ?? '',
          userName: dto.userName ?? '',
          xoId: xoId,
          createdAt: new Date(),
          lastVisit: new Date(),
          numGames: 0,
          numWins: 0,
          stars: 0,
        },
      });
    }

    // Возвращаем только нужные поля
    return this.prisma.user.findUnique({
      where: { telegramId: dto.telegramId },
      select: {
        firstName: true,
        numGames: true,
        numWins: true,
        stars: true,
      },
    });
  }

  async initUser(initData: any) {
    this.logger.log({
      event: 'initUserStarted',
      initData: {
        ...initData,
        auth_date: initData.auth_date,
        has_hash: !!initData.hash
      },
      timestamp: new Date().toISOString()
    });

    try {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: initData.id.toString() }
      });

      if (user) {
        this.logger.log({
          event: 'existingUserFound',
          telegramId: initData.id,
          userId: user.id,
          timestamp: new Date().toISOString()
        });

        // Обновляем существующего пользователя
        const updatedUser = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            userName: initData.username || user.userName,
            firstName: initData.first_name || user.firstName,
            lastName: initData.last_name || user.lastName,
            lastVisit: new Date()
          }
        });

        this.logger.log({
          event: 'userUpdated',
          telegramId: initData.id,
          userId: updatedUser.id,
          timestamp: new Date().toISOString()
        });

        return updatedUser;
      }

      // Создаем нового пользователя
      const newUser = await this.prisma.user.create({
        data: {
          telegramId: initData.id.toString(),
          userName: initData.username || '',
          firstName: initData.first_name || '',
          lastName: initData.last_name || '',
          numGames: 0,
          numWins: 0,
          stars: 0,
          lastVisit: new Date()
        }
      });

      this.logger.log({
        event: 'newUserCreated',
        telegramId: initData.id,
        userId: newUser.id,
        timestamp: new Date().toISOString()
      });

      return newUser;
    } catch (error) {
      this.logger.error({
        event: 'initUserError',
        error: error.message,
        initData: {
          ...initData,
          auth_date: initData.auth_date,
          has_hash: !!initData.hash
        },
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async updateUserStats(telegramId: string, won: boolean) {
    this.logger.log({
      event: 'updateUserStatsStarted',
      telegramId,
      won,
      timestamp: new Date().toISOString()
    });

    try {
      const user = await this.prisma.user.update({
        where: { telegramId },
        data: {
          numGames: { increment: 1 },
          numWins: won ? { increment: 1 } : undefined,
          lastVisit: new Date()
        }
      });

      this.logger.log({
        event: 'userStatsUpdated',
        telegramId,
        userId: user.id,
        newStats: {
          numGames: user.numGames,
          numWins: user.numWins
        },
        timestamp: new Date().toISOString()
      });

      return user;
    } catch (error) {
      this.logger.error({
        event: 'updateUserStatsError',
        telegramId,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async updateUserStars(telegramId: string, amount: number) {
    this.logger.log({
      event: 'updateUserStarsStarted',
      telegramId,
      amount,
      timestamp: new Date().toISOString()
    });

    try {
      const user = await this.prisma.user.update({
        where: { telegramId },
        data: {
          stars: { increment: amount },
          lastVisit: new Date()
        }
      });

      this.logger.log({
        event: 'userStarsUpdated',
        telegramId,
        userId: user.id,
        newStars: user.stars,
        amount,
        timestamp: new Date().toISOString()
      });

      return user;
    } catch (error) {
      this.logger.error({
        event: 'updateUserStarsError',
        telegramId,
        amount,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }
}
