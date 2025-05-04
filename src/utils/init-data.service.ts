// src/utils/init-data.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class InitDataService {
  private readonly botToken: string;

  constructor(private configService: ConfigService) {
    const token = this.configService.get<string>('BOT_TOKEN');
    if (!token) {
      throw new Error('BOT_TOKEN is not defined in environment variables');
    }
    this.botToken = token; // здесь TypeScript уже знает, что это точно string
  }

  validateInitData(initData: string): boolean {
    const secretKey = crypto
      .createHash('sha256')
      .update(this.botToken)
      .digest();

    const parsed = new URLSearchParams(initData);
    const hash = parsed.get('hash');
    parsed.delete('hash');

    const dataCheckString = [...parsed.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    const hmac = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    return hmac === hash;
  }

  parseInitData(initData: string): Record<string, any> {
    const parsed = new URLSearchParams(initData);
    const userStr = parsed.get('user');
    const user = userStr ? JSON.parse(userStr) : null;
    return {
      user,
    };
  }
}
