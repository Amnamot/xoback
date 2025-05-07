import { Injectable } from '@nestjs/common';
import { RequestWithAuth } from '../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UserService {
    constructor(
        private readonly prisma: PrismaService
    ) {}

    async getUser(req: RequestWithAuth) {
        let user = await this.prisma.user.findUnique({
            where: { id: req.tgId }
        });
    
        if (!user) {
            return await this.prisma.user.create({
                data: {
                    id: req.tgId,
                    username: req.username,
                    photo_url: req.photo_url,
                    first_name: req.firstName,
                    last_name: req.lastName
                },
            });
        } else {
            return await this.prisma.user.update({
                where: { id: req.tgId },
                data: {
                    username: req.username,
                    first_name: req.firstName,
                    last_name: req.lastName,
                    photo_url: req.photo_url,
                    last_visit: new Date()
                },
            });
        }
    }
}
