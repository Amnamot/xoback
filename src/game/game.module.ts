import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { RedisModule } from '@nestjs-modules/ioredis';
import { PrismaModule } from '../prisma/prisma.module';
import { InitDataService } from '../utils/init-data.service';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    RedisModule.forRoot({
      type: 'single',
      url: process.env.REDIS_URL
    }),
    PrismaModule,
  ],
  providers: [GameGateway, GameService, InitDataService],
  exports: [GameService]
})
export class GameModule {} 