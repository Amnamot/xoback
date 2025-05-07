import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { RequestWithAuth } from '../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';

@Injectable()
export class UserService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly httpService: HttpService,
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

    async createInvoiceLink({
        title,
        description,
        payload,
        photo_url,
        currency,
        prices,
    }: {
        title: string;
        description: string;
        payload: string;
        photo_url: string;
        currency: string;
        prices: { label: string; amount: number }[];
    }): Promise<string> {
        const apiUrl = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`;

        try {
            const response = await firstValueFrom(
                this.httpService.get(apiUrl, {
                    params: {
                        title,
                        description,
                        payload,
                        photo_url,
                        currency,
                        prices: JSON.stringify(prices),
                    },
                }),
            );

            if (response.data?.ok) {
                return response.data.result;
            } else {
                throw new BadRequestException(
                    `Oops! Something went wrong on our end. Please try again later: ${response.data?.description || 'Unknown error'}`,
                );
            }
        } catch (error) {
            throw new InternalServerErrorException(
                `Oops! Something went wrong on our end. Please try again later: ${error.message || error}`,
            );
        }
    }
}
