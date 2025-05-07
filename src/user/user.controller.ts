import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { RequestWithAuth } from '../auth/auth.types';
import { UserService } from './user.service';

@Controller()
export class UserController {
    constructor(
        private readonly userService: UserService
    ) { }

    @Get('user')
    @ApiBearerAuth()
    @UseGuards(AuthGuard)
    async getUser(@Req() request: RequestWithAuth) {
        return await this.userService.getUser(request)
    }

    @Get('getInvoiceLink')
    async getInvoiceLink(
        @Query('amount') amount: number
    ) {

        const prices = [
            { label: 'XTR', amount: 1 * amount },
        ];

        return this.userService.createInvoiceLink({
            title: `${amount} Stars`,
            description: `${amount} Stars`,
            photo_url: "https://cdn.notwise.co/energyRefill.jpg",
            payload: `${amount}`,
            currency: 'XTR',
            prices,
        });
    }
}
