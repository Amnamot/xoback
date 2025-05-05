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

interface RequestWithInitData extends Request {
  initData: InitDataParsed;
}

@Controller('lobby')
export class LobbyController {
  constructor(private readonly lobbyService: LobbyService) {}

  @UseGuards(AuthGuard)
  @Post('createInvite')
  async createInvite(@Req() request: RequestWithInitData) {
    const initData = request.initData;
    return this.lobbyService.createLobby(initData);
  }
}
