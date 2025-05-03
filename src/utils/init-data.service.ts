// src/utils/init-data.service.ts
import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { parse, validate } from '@tma.js/init-data-node';

@Injectable()
export class InitDataService {
  validateInitData(initData: string, botToken: string): boolean {
    try {
      console.log('🧪 RAW initData:', initData);
      validate(initData, botToken); // ← проверка подписи и срока действия
      const parsed = parse(initData);
      console.log('✅ InitData is valid. Parsed user:', parsed.user);
      return true;
    } catch (error: any) {
      console.error('❌ InitData validation error:', error);
      throw new UnauthorizedException('Invalid initData');
    }
  }

  parseInitData(initData: string) {
    return parse(initData);
  }
}
