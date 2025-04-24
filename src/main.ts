import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors({
    origin: [
      'https://xo.xuton.uno',
      'http://localhost:5173',
      'http://localhost:3000'
    ],
    credentials: true,
    methods: '*',
    allowedHeaders: ['*', 'Authorization', 'Content-Type']
  });


  const config = new DocumentBuilder()
    .setTitle("XO api")
    .setDescription("XO api")
    .setVersion("1.0")
    .addBearerAuth()
    .build();

  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true
  }));
  await app.listen(3000);
}

bootstrap();
