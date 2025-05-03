// utils.module.ts
import { Module } from '@nestjs/common';
import { InitDataService } from './init-data.service';

@Module({
  providers: [InitDataService],
  exports: [InitDataService], // ✅ важно: экспортируем для использования в других модулях
})
export class UtilsModule {}
