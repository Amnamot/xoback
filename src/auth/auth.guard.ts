import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { RequestWithAuth } from './auth.types';
import { parse, validate } from './auth.utils';
import { ExpiredError } from '../constants/auth.constants';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private readonly configService: ConfigService
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request: RequestWithAuth = context.switchToHttp().getRequest();

        const initData = this.extractInitDataFromHeader(request);
        if (!initData) {
            throw new UnauthorizedException('No init data provided');
        }

        try {
            const botToken = this.configService.get<string>('BOT_TOKEN');
            validate(initData, botToken!, 86400);
        } catch (error) {
            if (error instanceof ExpiredError) {
                throw new BadRequestException("Init data expired");
            }
            throw new BadRequestException("Invalid init data");
        }

        const payload = parse(initData);
        request.tgId = payload.user.id;
        request.username = payload.user.username;
        request.firstName = payload.user.firstName;
        request.lastName = payload.user.lastName;
        request.photo_url = payload.user.photo_url;

        return true;
    }

    private extractInitDataFromHeader(request: RequestWithAuth): string | null {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return null;
        }
        return authHeader.split(' ')[1];
    }
}

// @Injectable()
// export class AuthGuard implements CanActivate {

//    async canActivate(context: ExecutionContext): Promise<boolean> {
//        const request: RequestWithAuth = context.switchToHttp().getRequest();
//        const tgId = this.extractTgIdFromHeader(request);

//        if (!tgId) {
//            throw new UnauthorizedException('No tg id provided');
//        }

//        request.tgId = tgId;

//        return true;
//    }

//    private extractTgIdFromHeader(request: RequestWithAuth): string | null {
//        const authHeader = request.headers.authorization;
//        if (!authHeader || !authHeader.startsWith('Bearer ')) {
//            return null;
//        }
//        return authHeader.split(' ')[1];
//    }
// }