// src/main.ts 
// v1
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ConfigService } from '@nestjs/config';

class CustomIoAdapter extends IoAdapter {
  constructor(private app: any, private configService: ConfigService) {
    super(app);
  }

  createIOServer(port: number, options?: any) {
    const corsOrigin = this.configService.get<string>('CORS_ORIGIN');
    if (!corsOrigin) {
      throw new Error('CORS_ORIGIN is not defined in environment variables');
    }
    const origins = corsOrigin.split(',');
    
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: origins,
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'x-init-data', 'telegramId', 'connect-src']
      },
      allowEIO3: true,
      transports: ['websocket', 'polling'],
      path: '/socket.io/',
      pingTimeout: 60000,
      pingInterval: 25000,
      connectTimeout: 45000,
      upgradeTimeout: 30000
    });
    return server;
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  if (!corsOrigin) {
    throw new Error('CORS_ORIGIN is not defined in environment variables');
  }
  const origins = corsOrigin.split(',');

  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-init-data', 'telegramId', 'connect-src'],
  });

  // Настраиваем WebSocket
  const wsAdapter = new CustomIoAdapter(app, configService);
  app.useWebSocketAdapter(wsAdapter);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  console.log('✅ MAIN.TS CORS AND WEBSOCKET INIT APPLIED');
  console.log('🔒 CORS origins:', origins);

  await app.listen(3000);
}
bootstrap();
