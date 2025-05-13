// src/main.ts 
// v1
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';

class CustomIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: any) {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: ['https://igra.top', 'http://igra.top', 'http://localhost:3000', 'http://localhost:3001'],
        credentials: true,
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'x-init-data', 'telegramId']
      },
      allowEIO3: true,
      transports: ['websocket', 'polling']
    });
    return server;
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: ['https://igra.top', 'http://igra.top', 'http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-init-data', 'telegramId'], // добавляем telegramId
  });

  // Настраиваем WebSocket
  app.useWebSocketAdapter(new CustomIoAdapter(app));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  console.log('✅ MAIN.TS CORS AND WEBSOCKET INIT APPLIED');

  await app.listen(3000);
}
bootstrap();
