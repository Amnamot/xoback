import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { InitDataService } from '../utils/init-data.service'; // 🔹 добавлено

@Module({
  imports: [PrismaModule],
  controllers: [UserController],
  providers: [UserService, InitDataService], // 🔹 InitDataService подключён
})
export class UserModule {}
