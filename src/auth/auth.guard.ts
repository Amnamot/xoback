// src/auth/auth.guard.ts v1
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InitDataService } from '../utils/init-data.service';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
constructor(private readonly initDataService: InitDataService) {}

canActivate(context: ExecutionContext): boolean {
  const request = context.switchToHttp().getRequest<Request>();
  const initData = request.headers['x-init-data'] as string;

  if (!initData) {
    throw new UnauthorizedException('Missing initData');
  }

  const isValid = this.initDataService.validateInitData(initData);
  if (!isValid) {
    throw new UnauthorizedException('Invalid initData');
  }

  const parsed = this.initDataService.parseInitData(initData);

  // Сохраняем в request для дальнейшего использования
  (request as any).tgId = parsed.user?.id;
  (request as any).user = parsed.user;
  (request as any).initData = parsed;

  return true;
}
}
