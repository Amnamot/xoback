// src/user/user.service.ts v1
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertUserDto } from './dto/upsert-user.dto';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

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
        telegramId: true,
        firstName: true,
        numGames: true,
        numWins: true,
        stars: true,
      },
    });
  }
}
