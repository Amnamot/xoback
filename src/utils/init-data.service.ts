// src/utils/init-data.service.ts
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class InitDataService {
  validateInitData(initData: string, botToken: string): boolean {
    console.log('🧪 BOT_TOKEN (from env):', botToken);
    console.log('🧪 RAW initData:', initData);

    const parsed = new URLSearchParams(initData);

    parsed.delete('signature');
    const hash = parsed.get('hash');
    if (!hash) return false;
    parsed.delete('hash');

    // ✅ Специальная обработка поля user — убираем экранированные слеши
    const entries = [...parsed.entries()].map(([key, value]) => {
      if (key === 'user') {
        value = value.replace(/\\\//g, '/');
      }
      return [key, value];
    });

    const dataCheckString = entries
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    console.log('🧪 Data check string:\n', dataCheckString);

    const secret = crypto.createHash('sha256').update(botToken).digest();
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    console.log('🧪 Computed HMAC:', hmac);
    console.log('🧪 Received hash:', hash);

    return hmac === hash;
  }
}
