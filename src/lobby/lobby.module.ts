// src/lobby/lobby.module.ts v2
import { Module } from '@nestjs/common';
import { LobbyController } from './lobby.controller';
import { LobbyService } from './lobby.service';
import { UtilsModule } from '../utils/utils.module';
import { HttpModule } from '@nestjs/axios'; // ✅ добавлено

@Module({
  imports: [UtilsModule, HttpModule], // ✅ добавлено
  controllers: [LobbyController],
  providers: [LobbyService]
})
export class LobbyModule {}
