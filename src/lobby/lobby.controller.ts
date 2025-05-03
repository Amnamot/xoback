import { Controller, Post, Body } from '@nestjs/common';
import { LobbyService } from './lobby.service';

@Controller('lobby')
export class LobbyController {
  constructor(private readonly lobbyService: LobbyService) {}

  @Post()
  async createLobby(@Body() body: { initData: string }) {
    return this.lobbyService.createLobby(body.initData);
  }
}
