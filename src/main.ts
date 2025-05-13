// src/main.ts 
// v1
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: ['https://igra.top', 'wss://igra.top'], // ✅ разрешённый фронтовый домен и WebSocket
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-init-data'], // ✅ разрешённые заголовки
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  console.log('✅ MAIN.TS CORS INIT APPLIED');

  await app.listen(3000);
}
bootstrap();
