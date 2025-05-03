import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class InitDataService {
  validateInitData(initData: string, botToken: string): boolean {
    const parsed = new URLSearchParams(initData);

    parsed.delete('signature'); // ✅ удаляем перед проверкой
    const hash = parsed.get('hash');
    if (!hash) return false;
    parsed.delete('hash');

    const dataCheckString = [...parsed.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    const secret = crypto.createHash('sha256').update(botToken).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    return hmac === hash;
  }
}
