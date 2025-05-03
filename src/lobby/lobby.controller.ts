import {
    Controller,
    Post,
    Body,
    UnauthorizedException,
  } from '@nestjs/common';
  import { LobbyService } from './lobby.service';
  import { InitDataService } from '../utils/init-data.service';
  
  @Controller('lobby')
  export class LobbyController {
    constructor(
      private readonly lobbyService: LobbyService,
      private readonly initDataService: InitDataService,
    ) {}
  
    @Post()
    async createLobby(@Body() body: { initData: string }) {
      const { initData } = body;
  
      const isValid = this.initDataService.validateInitData(
        initData,
        process.env.BOT_TOKEN!,
      );
  
      if (!isValid) {
        throw new UnauthorizedException('Invalid initData');
      }
  
      const userStr = new URLSearchParams(initData).get('user');
      const user = userStr ? JSON.parse(decodeURIComponent(userStr)) : null;
  
      if (!user?.id || !user?.first_name) {
        throw new UnauthorizedException('Missing user data');
      }
  
      return this.lobbyService.createLobby(user);
    }
  }
  