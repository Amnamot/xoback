import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { RequestWithAuth } from '../auth/auth.types';
import { UserService } from './user.service';

@Controller()
export class UserController {
    constructor(
        private readonly userService: UserService
    ) {}

    @Get('user')
    @ApiBearerAuth()
    @UseGuards(AuthGuard)
    async getUser(@Req() request: RequestWithAuth) {
        return await this.userService.getUser(request)
    }
}
