// src/lobby/lobby.controller.ts v5
import {
  Controller,
  Post,
  Req,
  UseGuards,
  Delete,
  Body
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

  @Post('create')
  @UseGuards(AuthGuard)
  createLobby(@Req() req: RequestWithInitData) {
    return this.lobbyService.createLobby(req.initData);
  }

  @Post('createInvite')
  @UseGuards(AuthGuard)
  createInvite(@Req() req: RequestWithAuth) {
    return this.lobbyService.createInvite(req.tgId);
  }

  @Post('cancel')
  @UseGuards(AuthGuard)
  cancelLobby(@Req() req: RequestWithAuth) {
    return this.lobbyService.cancelLobby(req.tgId);
  }

  @Post('join')
  @UseGuards(AuthGuard)
  joinLobby(@Req() req: RequestWithAuth, @Body() body: { lobbyId: string }) {
    return this.lobbyService.joinLobby(req.tgId, body.lobbyId);
  }
}
