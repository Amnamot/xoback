// lobby.controller.ts
import {
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LobbyService } from './lobby.service';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';

@Controller('lobby')
export class LobbyController {
  constructor(private readonly lobbyService: LobbyService) {}

  @UseGuards(AuthGuard) // ✅ добавлено
  @Post('createInvite')
  async createInvite(@Req() request: Request) {
    const initData = request.headers['x-init-data'] as string;
    return this.lobbyService.createLobby(initData);
  }
}
