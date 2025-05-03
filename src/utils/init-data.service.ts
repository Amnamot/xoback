import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class InitDataService {
  validateInitData(initData: string, botToken: string): boolean {
    console.log('🧪 BOT_TOKEN (from env):', botToken);
    console.log('🧪 RAW initData:', initData);

    const parsed = new URLSearchParams(initData);

    const hash = parsed.get('hash');
    if (!hash) return false;
    parsed.delete('hash');

    // Специальная обработка поля user — убираем экранированные слеши
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

    // Создание секретного ключа с использованием 'WebAppData'
    const secretKey = crypto
      .createHmac('sha256', botToken)
      .update('WebAppData')
      .digest();

    const hmac = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    console.log('🧪 Computed HMAC:', hmac);
    console.log('🧪 Received hash:', hash);

    return hmac === hash;
  }
}
