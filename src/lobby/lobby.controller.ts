// src/lobby/lobby.controller.ts v8
import {
  Controller,
  Post,
  Req,
  UseGuards,
  Delete,
  Body,
  Get
} from '@nestjs/common';
import { LobbyService } from './lobby.service';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { InitDataParsed } from '../utils/init-data.service';
import { RequestWithAuth } from '../types';

interface RequestWithInitData extends Request {
  initData: InitDataParsed;
}

@Controller('lobby')
export class LobbyController {
  constructor(private readonly lobbyService: LobbyService) {}

  @Post('createInvite')
  @UseGuards(AuthGuard)
  createInvite(@Req() req: RequestWithAuth) {
    return this.lobbyService.createInvite(req.tgId);
  }

  @Post('join')
  @UseGuards(AuthGuard)
  joinLobby(@Req() req: RequestWithAuth, @Body() body: { lobbyId: string }) {
    return this.lobbyService.joinLobby(req.tgId, body.lobbyId);
  }

  @Get('timeleft')
  @UseGuards(AuthGuard)
  getTimeLeft(@Req() req: RequestWithAuth) {
    return this.lobbyService.getTimeLeft(req.tgId);
  }

  @Delete('cancel')
  cancelLobbyPublic(@Body() body: { lobbyId: string; telegramId: string }) {
    return this.lobbyService.cancelLobbyPublic(body.lobbyId, body.telegramId);
  }
}
