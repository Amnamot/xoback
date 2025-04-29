// user.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async createOrUpdateUser(data: {
    telegramId: string;
    userName: string;
    firstName: string;
    lastName: string;
  }) {
    const existing = await this.prisma.user.findUnique({
      where: { telegramId: data.telegramId },
    });

    if (existing) {
      return this.prisma.user.update({
        where: { telegramId: data.telegramId },
        data: { lastVisit: new Date() },
      });
    }

    const generateXoId = (): string => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    };

    return this.prisma.user.create({
      data: {
        telegramId: data.telegramId,
        userName: data.userName,
        firstName: data.firstName,
        lastName: data.lastName,
        lastVisit: new Date(),
        xoId: generateXoId(),
      },
    });
  }
}
