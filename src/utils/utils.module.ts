// src/utils/utils.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InitDataService } from './init-data.service';

@Module({
  imports: [ConfigModule],
  providers: [InitDataService],
  exports: [InitDataService],
})
export class UtilsModule {}
