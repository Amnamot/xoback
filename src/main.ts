// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Swagger конфигурация
  const config = new DocumentBuilder()
    .setTitle('XO API')
    .setDescription('API для WebApp Telegram')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  // Запуск приложения
  await app.listen(3000);
}
bootstrap();
