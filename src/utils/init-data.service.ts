import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class InitDataService {
  validateInitData(initData: string, botToken: string): boolean {
    console.log('🧪 BOT_TOKEN (from env):', botToken); // логируем токен
    console.log('🧪 RAW initData:', initData); // логируем входящие initData

    const parsed = new URLSearchParams(initData);

    const hash = parsed.get('hash');
    if (!hash) return false;

    parsed.delete('hash');
    parsed.delete('signature'); // на всякий случай

    const dataCheckString = [...parsed.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    console.log('🧪 Data check string:\n', dataCheckString); // логируем строку для HMAC

    const secret = crypto.createHash('sha256').update(botToken).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    console.log('🧪 Computed HMAC:', hmac);
    console.log('🧪 Received hash:', hash);

    return hmac === hash;
  }
}
