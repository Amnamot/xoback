// src/lobby/lobby.module.ts v2
import { Module } from '@nestjs/common';
import { LobbyController } from './lobby.controller';
import { LobbyService } from './lobby.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { GameModule } from '../game/game.module';
import { UtilsModule } from '../utils/utils.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    HttpModule,
    GameModule,
    UtilsModule
  ],
  controllers: [LobbyController],
  providers: [LobbyService],
  exports: [LobbyService]
})
export class LobbyModule {}
