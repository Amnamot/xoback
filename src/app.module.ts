// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // <-- добавлено
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { PrismaModule } from './prisma/prisma.module';
import { LobbyModule } from './lobby/lobby.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // <-- подключение .env
    UserModule,
    PrismaModule,
    LobbyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
