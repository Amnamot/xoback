// src/lobby/lobby.controller.ts v1
import {
  Controller,
  Post,
  Req,
  UseGuards,
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

  @Post('createLobby')
  @UseGuards(AuthGuard)
  async createLobby(@Req() req: RequestWithInitData) {
    const initData = req.initData;
    return this.lobbyService.createLobby(initData);
  }

  @Post('createInvite')
  @UseGuards(AuthGuard)
  async createInvite(@Req() req: RequestWithAuth) {
    return this.lobbyService.createInvite(req.tgId);
  }
}
