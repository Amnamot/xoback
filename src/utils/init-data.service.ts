// src/utils/init-data.service.ts 
// v
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse, validate } from '@tma.js/init-data-node';

@Injectable()
export class InitDataService {
  private readonly botToken: string;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('BOT_TOKEN');
    if (!token) {
      throw new Error('BOT_TOKEN is not defined in environment variables');
    }
    this.botToken = token;
  }

  validateInitData(initData: string): boolean {
    try {
      validate(initData, this.botToken);
      return true;
    } catch (error) {
      console.error('❌ Invalid initData:', error);
      throw new UnauthorizedException('Invalid initData');
    }
  }

  parseInitData(initData: string) {
    return parse(initData);
  }
}
