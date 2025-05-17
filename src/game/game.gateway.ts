// src/game/game.gateway.ts v1.0.2
import { 
  WebSocketGateway, 
  WebSocketServer, 
  SubscribeMessage, 
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameService } from './game.service';
import {
  CreateLobbyDto,
  JoinLobbyDto,
  MakeMoveDto,
  UpdatePlayerTimeDto,
  UpdateViewportDto,
  GameOverDto,
  JoinGameDto,
  TimeExpiredDto,
  CreateInviteDto,
  CancelLobbyDto
} from './dto/socket.dto';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

// Интерфейсы для Redis
interface PlayerData {
  lobbyId?: string;
  gameId?: string;
  role: 'creator' | 'opponent';
  marker: '⭕' | '❌';
}

interface LobbyData {
  creatorId: string;
  opponentId?: string;
  status: 'pending' | 'active';
}

interface GameData {
  board: string[];
  currentTurn: string;
  lastMoveTime: number;
}

@Injectable()
@WebSocketGateway({
  path: '/socket.io/',
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  allowUpgrades: true,
  cookie: {
    name: 'io',
    httpOnly: true,
    path: '/'
  }
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private connectedClients = new Map<string, Socket>();
  private clientGames = new Map<string, string>(); // telegramId -> gameId
  private clientLobbies = new Map<string, string>(); // telegramId -> lobbyId
  private reconnectTimeouts = new Map<string, NodeJS.Timeout>(); // telegramId -> timeout
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private readonly gameService: GameService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    console.log('WebSocket URL:', this.configService.get('SOCKET_URL'));
    
    this.cleanupInterval = setInterval(() => this.cleanupDisconnectedClients(), 60000);
  }

  // Методы для работы с Redis
  private async saveToRedis(key: string, data: any) {
    try {
      await this.redis.set(key, JSON.stringify(data), 'EX', 180);
      console.log('📝 [Redis] Saved data:', {
        key,
        type: key.split(':')[0],
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ [Redis] Error saving data:', {
        key,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  private async getFromRedis(key: string) {
    try {
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('❌ [Redis] Error getting data:', {
        key,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  }

  private async updateTTL(key: string) {
    try {
      await this.redis.expire(key, 180);
      console.log('⏱️ [Redis] Updated TTL:', {
        key,
        ttl: 180,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ [Redis] Error updating TTL:', {
        key,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  async handleConnection(client: Socket) {
    const telegramId = client.handshake.query.telegramId as string;
    if (!telegramId) {
      client.disconnect();
      return;
    }

    console.log('👋 Client connected:', {
      telegramId,
      socketId: client.id,
      rooms: Array.from(client.rooms)
    });

    try {
      // Получаем данные игрока из Redis
      const playerData = await this.getFromRedis(`player:${telegramId}`);
      if (playerData?.lobbyId) {
        console.log('🔄 [Reconnect] Found player data:', {
          telegramId,
          playerData,
          timestamp: new Date().toISOString()
        });

        // Получаем данные лобби
        const lobbyData = await this.getFromRedis(`lobby:${playerData.lobbyId}`);
        if (lobbyData) {
          console.log('🎮 [Reconnect] Found lobby data:', {
            lobbyId: playerData.lobbyId,
            lobbyData,
            timestamp: new Date().toISOString()
          });

          // Проверяем наличие активной игры
          const gameData = await this.getFromRedis(`game:${playerData.lobbyId}`);
          
          if (gameData) {
            // Если есть активная игра - подключаем к ней
            console.log('🎲 [Reconnect] Found active game:', {
              lobbyId: playerData.lobbyId,
              gameData,
              timestamp: new Date().toISOString()
            });

            client.join(playerData.lobbyId);
            this.clientGames.set(telegramId, playerData.lobbyId);

            // Обновляем TTL для всех ключей
            await this.updateTTL(`player:${telegramId}`);
            await this.updateTTL(`lobby:${playerData.lobbyId}`);
            await this.updateTTL(`game:${playerData.lobbyId}`);

            // Отправляем текущее состояние игры
            client.emit('gameState', {
              board: gameData.board,
              currentPlayer: gameData.currentTurn === telegramId ? 
                (playerData.role === 'creator' ? 'X' : 'O') : 
                (playerData.role === 'creator' ? 'O' : 'X'),
              scale: 1,
              position: { x: 0, y: 0 },
              time: 0,
              gameData
            });

            console.log('✅ [Reconnect] Player reconnected to game:', {
              telegramId,
              lobbyId: playerData.lobbyId,
              timestamp: new Date().toISOString()
            });
          } else if (playerData.inviteSent) {
            // Если инвайт был отправлен - восстанавливаем лобби
            console.log('📨 [Reconnect] Restoring lobby after invite:', {
              telegramId,
              lobbyId: playerData.lobbyId,
              timestamp: new Date().toISOString()
            });

            client.join(playerData.lobbyId);
            this.clientLobbies.set(telegramId, playerData.lobbyId);

            // Обновляем TTL
            await this.updateTTL(`player:${telegramId}`);
            await this.updateTTL(`lobby:${playerData.lobbyId}`);

            // Отправляем события для показа WaitModal
            client.emit('setShowWaitModal', {
              show: true,
              creatorMarker: playerData.marker
            });

            this.server.to(playerData.lobbyId).emit('lobbyReady', { 
              lobbyId: playerData.lobbyId,
              timestamp: Date.now(),
              creatorMarker: playerData.marker
            });
          }
        }
      }
    } catch (error) {
      console.error('❌ [Reconnect] Error handling connection:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        telegramId,
        timestamp: new Date().toISOString()
      });
    }

    this.connectedClients.set(telegramId, client);
  }

  async handleDisconnect(client: Socket) {
    const telegramId = client.handshake.query.telegramId as string;
    if (!telegramId) return;

    this.connectedClients.delete(telegramId);
    
    // Проверяем наличие активного лобби
    const lobbyId = this.clientLobbies.get(telegramId);
    if (lobbyId) {
      // Помечаем лобби как "в ожидании переподключения"
      await this.gameService.markLobbyPending(lobbyId);
      
      // Устанавливаем таймер на удаление
      const timeout = setTimeout(async () => {
        const lobby = await this.gameService.getLobby(lobbyId);
        if (lobby && lobby.status === 'pending') {
          // Удаляем лобби только если оно все еще в статусе pending
          await this.gameService.deleteLobby(lobbyId);
          this.clientLobbies.delete(telegramId);
          this.server.to(lobbyId).emit('lobbyDeleted', {
            reason: 'Creator disconnected and did not reconnect'
          });
        }
      }, 30000); // 30 секунд на переподключение

      this.reconnectTimeouts.set(telegramId, timeout);
    }
    
    // Проверяем, находится ли игрок в активной игре
    const gameId = this.clientGames.get(telegramId);
    if (gameId) {
      const session = await this.gameService.getGameSession(gameId);
      if (session) {
        // Уведомляем обоппонента об отключении
        this.server.to(gameId).emit('playerDisconnected', { telegramId });

        // Устанавливаем таймаут на переподключение
        const timeout = setTimeout(async () => {
          // Если игрок не переподключился за 30 секунд, завершаем игру
          const winnerId = session.creatorId === telegramId ? session.opponentId : session.creatorId;
          await this.gameService.endGameSession(gameId, winnerId);
          this.server.to(gameId).emit('gameEnded', {
            winner: winnerId,
            reason: 'disconnect'
          });
          this.clientGames.delete(telegramId);
          this.reconnectTimeouts.delete(telegramId);
        }, 30000); // 30 секунд на переподключение

        this.reconnectTimeouts.set(telegramId, timeout);
      }
    }
  }

  @SubscribeMessage('createLobby')
  @UsePipes(new ValidationPipe())
  async handleCreateLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: CreateLobbyDto
  ) {
    console.log('🎮 Handling createLobby request:', { 
      telegramId: data.telegramId, 
      socketId: client.id,
      rooms: Array.from(client.rooms),
      adapter: this.server.sockets.adapter.rooms.size
    });
    
    try {
      // Создание лобби через GameService
      const lobby = await this.gameService.createLobby(data.telegramId);
      
      if (!lobby) {
        console.warn('⚠️ Lobby creation returned null');
        return { 
          status: 'error',
          message: 'Failed to create lobby: null response',
          timestamp: Date.now()
        };
      }
      
      console.log('✅ Lobby created:', { 
        lobbyId: lobby.id, 
        creatorId: data.telegramId,
        status: lobby.status
      });
      
      // Сохраняем данные в Redis
      await this.saveToRedis(`player:${data.telegramId}`, {
        lobbyId: lobby.id,
        role: 'creator',
        marker: '❌'
      });

      await this.saveToRedis(`lobby:${lobby.id}`, {
        creatorId: data.telegramId,
        status: 'pending'
      });
      
      // Сохраняем связь клиент-лобби
      this.clientLobbies.set(data.telegramId, lobby.id);
      console.log('🔗 Client-lobby association saved:', { 
        telegramId: data.telegramId, 
        lobbyId: lobby.id,
        mappingSize: this.clientLobbies.size
      });
      
      // Добавляем клиента в комнату лобби
      client.join(lobby.id);
      console.log('👥 Client joined lobby room:', { 
        socketId: client.id, 
        lobbyId: lobby.id,
        updatedRooms: Array.from(client.rooms)
      });
      
      // Отправляем событие о готовности лобби
      this.server.to(lobby.id).emit('lobbyReady', { 
        lobbyId: lobby.id,
        timestamp: Date.now(),
        creatorMarker: '❌'
      });
      console.log('❌ [Create Lobby] Sent creator marker:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        socketId: client.id,
        timestamp: new Date().toISOString()
      });
      
      return { 
        status: 'created', 
        lobbyId: lobby.id,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ Error in handleCreateLobby:', error);
      
      // Очищаем связи при ошибке
      this.clientLobbies.delete(data.telegramId);
      console.log('🧹 Cleaned up client-lobby association for:', data.telegramId);
      
      return { 
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to create lobby',
        timestamp: Date.now()
      };
    }
  }

  @SubscribeMessage('joinLobby')
  @UsePipes(new ValidationPipe())
  async handleJoinLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinLobbyDto
  ) {
    console.log('🎮 Handling joinLobby request:', {
      lobbyId: data.lobbyId,
      telegramId: data.telegramId,
      socketId: client.id,
      timestamp: new Date().toISOString(),
      clientRooms: Array.from(client.rooms),
      query: client.handshake.query,
      headers: client.handshake.headers
    });

    const lobby = await this.gameService.getLobby(data.lobbyId);

    if (!lobby) {
      console.warn('❌ Lobby not found:', {
        lobbyId: data.lobbyId,
        requestedBy: data.telegramId,
        timestamp: new Date().toISOString(),
        socketId: client.id
      });
      return { 
        status: 'error',
        errorType: 'expired',
        message: 'The battle you are looking for is over.<br />Ask your friend to create a new invitation!<br />Or create your own Game!'
      };
    }

    // Обновляем TTL для лобби
    await this.updateTTL(`lobby:${data.lobbyId}`);

    if (lobby.creatorId === data.telegramId) {
      // Обновляем TTL для создателя
      await this.updateTTL(`player:${data.telegramId}`);

      const creatorSocket = this.connectedClients.get(data.telegramId);
      console.log('⭕ [Creator State] Creator joining their own lobby:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        socketState: {
          connected: creatorSocket?.connected || false,
          rooms: Array.from(creatorSocket?.rooms || []),
          handshake: creatorSocket?.handshake?.query || {},
          transport: creatorSocket?.conn?.transport?.name || 'unknown'
        },
        mappings: {
          inClientGames: this.clientGames.has(data.telegramId),
          inClientLobbies: this.clientLobbies.has(data.telegramId),
          inConnectedClients: this.connectedClients.has(data.telegramId)
        },
        timestamp: new Date().toISOString()
      });

      // Проверяем существующую игровую сессию в Redis
      const gameData = await this.getFromRedis(`game:${data.lobbyId}`);
      if (gameData) {
        console.log('🎮 [Creator Rejoin] Found active game session:', {
          lobbyId: data.lobbyId,
          gameData,
          timestamp: new Date().toISOString()
        });

        // Подключаем создателя к игровой комнате
        client.join(data.lobbyId);
        this.clientGames.set(data.telegramId, data.lobbyId);

        // Обновляем TTL для игры
        await this.updateTTL(`game:${data.lobbyId}`);

        // Отправляем текущее состояние игры
        client.emit('gameState', {
          board: gameData.board,
          currentPlayer: gameData.currentTurn === gameData.creatorId ? 'X' : 'O',
          scale: 1,
          position: { x: 0, y: 0 },
          time: 0,
          gameData
        });

        return { status: 'creator_game_joined' };
      }

      // Если игровой сессии нет, подключаем к лобби
      client.join(data.lobbyId);
      this.clientLobbies.set(data.telegramId, data.lobbyId);

      return { status: 'creator_lobby_joined' };
    }

    // Логика для присоединения оппонента
    const lobbyData = await this.getFromRedis(`lobby:${data.lobbyId}`);
    if (lobbyData && lobbyData.status === 'active') {
      return {
        status: 'error',
        errorType: 'full',
        message: 'This game already has an opponent'
      };
    }

    // Сохраняем данные оппонента в Redis
    await this.saveToRedis(`player:${data.telegramId}`, {
      lobbyId: data.lobbyId,
      role: 'opponent',
      marker: '⭕'
    });

    // Обновляем данные лобби
    await this.saveToRedis(`lobby:${data.lobbyId}`, {
      ...lobbyData,
      opponentId: data.telegramId,
      status: 'active'
    });

    // Создаем игровую сессию
    await this.saveToRedis(`game:${data.lobbyId}`, {
      board: Array(9).fill(''),
      currentTurn: lobby.creatorId,
      lastMoveTime: Date.now()
    });

    // Подключаем оппонента к комнате
    client.join(data.lobbyId);
    this.clientGames.set(data.telegramId, data.lobbyId);

    // Отправляем событие о начале игры
    this.server.to(data.lobbyId).emit('gameStart', {
      session: {
        id: data.lobbyId,
        creatorId: lobby.creatorId,
        opponentId: data.telegramId
      }
    });

    return { status: 'joined' };
  }

  @SubscribeMessage('makeMove')
  @UsePipes(new ValidationPipe())
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: MakeMoveDto
  ) {
    // Получаем текущее состояние игры из Redis
    const gameData = await this.getFromRedis(`game:${data.gameId}`);
    if (!gameData) {
      return { status: 'error', message: 'Game session not found' };
    }

    const currentTime = Date.now();
    const timeSinceLastMove = currentTime - gameData.lastMoveTime;
    const MAX_MOVE_TIME = 30000;

    if (timeSinceLastMove > MAX_MOVE_TIME) {
      const winner = gameData.currentTurn === gameData.creatorId ? gameData.opponentId : gameData.creatorId;
      
      // Очищаем данные игры из Redis
      await this.redis.del(`game:${data.gameId}`);
      
      this.server.to(data.gameId).emit('gameEnded', {
        winner,
        reason: 'timeout',
        statistics: {
          totalTime: Math.floor((currentTime - gameData.startTime) / 1000),
          moves: gameData.board.filter((cell: string) => cell !== '').length,
          lastMoveTime: timeSinceLastMove
        }
      });

      return { status: 'error', message: 'Move time expired' };
    }

    if (data.player !== gameData.currentTurn) {
      return { status: 'error', message: 'Not your turn' };
    }

    // Обновляем состояние игры
    const newBoard = [...gameData.board];
    newBoard[Number(data.position)] = data.player === gameData.creatorId ? '❌' : '⭕';

    const updatedGameData = {
      ...gameData,
      board: newBoard,
      lastMoveTime: currentTime,
      currentTurn: data.player === gameData.creatorId ? gameData.opponentId : gameData.creatorId
    };

    // Сохраняем обновленное состояние в Redis
    await this.saveToRedis(`game:${data.gameId}`, updatedGameData);

    // Обновляем TTL для всех связанных ключей
    await this.updateTTL(`game:${data.gameId}`);
    await this.updateTTL(`player:${data.player}`);
    await this.updateTTL(`lobby:${data.gameId}`);

    this.server.to(data.gameId).emit('moveMade', {
      moveId: `move_${currentTime}`,
      position: data.position,
      player: data.player,
      gameState: {
        board: newBoard,
        currentTurn: updatedGameData.currentTurn,
        serverTime: currentTime,
        moveStartTime: currentTime,
        timeLeft: MAX_MOVE_TIME
      }
    });

    return { status: 'success' };
  }

  @SubscribeMessage('updatePlayerTime')
  @UsePipes(new ValidationPipe())
  async handleTimeUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UpdatePlayerTimeDto
  ) {
    const session = await this.gameService.getGameSession(data.gameId);
    
    if (!session) {
      return { status: 'error', message: 'Game session not found' };
    }

    const updatedSession = await this.gameService.updateGameSession(data.gameId, {
      playerTime1: data.playerTimes.playerTime1,
      playerTime2: data.playerTimes.playerTime2
    });

    this.server.to(data.gameId).emit('timeUpdated', {
      playerTime1: updatedSession.playerTime1,
      playerTime2: updatedSession.playerTime2
    });

    return { status: 'success' };
  }

  @SubscribeMessage('gameOver')
  @UsePipes(new ValidationPipe())
  async handleGameOver(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: GameOverDto
  ) {
    await this.gameService.endGameSession(data.gameId, data.winner);
    this.server.to(data.gameId).emit('gameEnded', { winner: data.winner });
    
    const session = await this.gameService.getGameSession(data.gameId);
    if (session) {
      this.clientGames.delete(session.creatorId);
      this.clientGames.delete(session.opponentId);
    }
  }

  @SubscribeMessage('joinGame')
  @UsePipes(new ValidationPipe())
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinGameDto
  ) {
    this.clientGames.set(data.telegramId, data.gameId);
    client.join(data.gameId);
    
    return { status: 'joined' };
  }

  @SubscribeMessage('timeExpired')
  @UsePipes(new ValidationPipe())
  async handleTimeExpired(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: TimeExpiredDto
  ) {
    const session = await this.gameService.getGameSession(data.gameId);
    
    if (!session) {
      return { status: 'error', message: 'Game session not found' };
    }

    const winner = data.player === session.creatorId ? session.opponentId : session.creatorId;

    await this.gameService.endGameSession(data.gameId, winner);

    this.server.to(data.gameId).emit('gameEnded', {
      winner,
      reason: 'timeout',
      statistics: {
        totalTime: Math.floor((Date.now() - session.startedAt) / 1000),
        moves: session.numMoves,
        playerTime1: session.playerTime1,
        playerTime2: session.playerTime2
      }
    });

    return { status: 'success' };
  }

  @SubscribeMessage('createInvite')
  @UsePipes(new ValidationPipe())
  async handleCreateInvite(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: CreateInviteDto
  ) {
    console.log('🔍 Creating invite for telegramId:', data.telegramId);
    
    try {
      // Получаем лобби из GameService
      const lobby = await this.gameService.findLobbyByCreator(data.telegramId);
      
      if (!lobby) {
        console.log('❌ No matching lobby found for telegramId:', data.telegramId);
        return { error: 'Lobby not found' };
      }

      console.log('✅ Found lobby:', lobby.id);

      // Сохраняем данные в Redis
      await this.saveToRedis(`player:${data.telegramId}`, {
        lobbyId: lobby.id,
        role: 'creator',
        marker: '❌',
        inviteSent: true,
        lastAction: 'invite_sent',
        timestamp: Date.now()
      });

      // Обновляем данные лобби
      await this.saveToRedis(`lobby:${lobby.id}`, {
        creatorId: data.telegramId,
        status: 'pending',
        inviteSent: true,
        lastAction: 'invite_sent',
        timestamp: Date.now()
      });

      // Формируем сообщение для отправки
      const result = {
        type: "article",
        id: randomBytes(5).toString("hex"),
        title: "Invitation to the game!",
        description: "Click to accept the call!",
        input_message_content: {
          message_text: `❌ Invitation to the game ⭕️\n\nPlayer invites you\nto fight in endless TicTacToe`,
        },
        reply_markup: {
          inline_keyboard: [[
            {
              text: "⚔️ Accept the battle 🛡",
              url: `https://t.me/TacTicToe_bot?startapp=${lobby.id}`
            }
          ]]
        },
        thumbnail_url: "https://brown-real-meerkat-526.mypinata.cloud/ipfs/bafkreihszmccida3akvw4oshrwcixy5xnpimxiprjrnqo5aevzshj4foda",
        thumbnail_width: 300,
        thumbnail_height: 300,
      };

      console.log('📤 [Invite] Preparing Telegram API request:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        timestamp: new Date().toISOString()
      });

      // Отправляем сообщение через Telegram Bot API
      const BOT_TOKEN = this.configService.get("BOT_TOKEN");
      const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/savePreparedInlineMessage`;
      const url = `${apiUrl}?user_id=${data.telegramId}&result=${encodeURIComponent(JSON.stringify(result))}&allow_user_chats=true&allow_group_chats=true`;
      
      const { data: response } = await firstValueFrom(this.httpService.get(url));
      
      console.log('📨 [Invite] Telegram API response:', {
        response,
        lobbyId: lobby.id,
        timestamp: new Date().toISOString()
      });

      return { 
        messageId: response.result.id, 
        lobbyId: lobby.id 
      };
    } catch (error) {
      console.error('🛑 [Invite] Error creating invite:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        telegramId: data.telegramId,
        timestamp: new Date().toISOString()
      });
      return { error: 'Failed to create invite' };
    }
  }

  @SubscribeMessage('cancelLobby')
  @UsePipes(new ValidationPipe())
  async handleCancelLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: CancelLobbyDto
  ) {
    console.log('🔄 Handling cancelLobby request:', {
      telegramId: data.telegramId,
      socketId: client.id,
      timestamp: new Date().toISOString()
    });

    try {
      // Находим лобби по создателю
      console.log('🔍 Searching for lobby by creator:', data.telegramId);
      const lobby = await this.gameService.findLobbyByCreator(data.telegramId);
      
      if (!lobby) {
        console.warn('⚠️ No active lobby found for creator:', {
          telegramId: data.telegramId,
          timestamp: new Date().toISOString()
        });
        return {
          status: 'error',
          message: 'No active lobby found',
          timestamp: Date.now()
        };
      }

      console.log('🎯 Found lobby to cancel:', {
        lobbyId: lobby.id,
        status: lobby.status,
        timestamp: new Date().toISOString()
      });

      // Удаляем лобби
      console.log('🗑️ Attempting to delete lobby:', lobby.id);
      try {
        await this.gameService.deleteLobby(lobby.id);
        console.log('✅ Lobby deleted from database:', lobby.id);
      } catch (error) {
        console.error('❌ Failed to delete lobby:', {
          lobbyId: lobby.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
        return {
          status: 'error',
          message: 'Failed to delete lobby',
          timestamp: Date.now()
        };
      }
      
      // Очищаем связь клиент-лобби
      console.log('🧹 Cleaning up client-lobby association for:', data.telegramId);
      this.clientLobbies.delete(data.telegramId);
      
      // Отправляем событие об удалении лобби всем в комнате
      const timestamp = Date.now();
      console.log('📢 Broadcasting lobbyDeleted event to room:', lobby.id);
      this.server.to(lobby.id).emit('lobbyDeleted', {
        reason: 'Cancelled by creator',
        timestamp
      });

      console.log('✅ Lobby cancellation completed:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        timestamp: new Date(timestamp).toISOString()
      });

      return {
        status: 'success',
        timestamp
      };
    } catch (error) {
      console.error('🛑 Error in handleCancelLobby:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to cancel lobby',
        timestamp: Date.now()
      };
    }
  }

  @SubscribeMessage('uiState')
  async handleUiState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { state: 'loader' | 'startScreen' | 'waitModal' | 'loss' | 'appClosed', telegramId: string, details?: any }
  ) {
    const states: Record<string, string> = {
      'loader': '⌛ User on Loader screen',
      'startScreen': '🧧 User on Start screen',
      'waitModal': '⏳ WaitModal is shown',
      'loss': '💀 User on Loss screen',
      'appClosed': '👎 User closed the app'
    };

    console.log(`${states[data.state] || '🔄 UI State change'}:`, {
      telegramId: data.telegramId,
      socketId: client.id,
      state: data.state,
      ...(data.details && { details: data.details })
    });

    try {
      // При сворачивании приложения обновляем TTL
      if (data.state === 'appClosed') {
        // Получаем данные игрока
        const playerData = await this.getFromRedis(`player:${data.telegramId}`);
        if (playerData?.lobbyId) {
          console.log('⏱️ [AppClosed] Updating TTL for:', {
            telegramId: data.telegramId,
            lobbyId: playerData.lobbyId,
            timestamp: new Date().toISOString()
          });

          // Обновляем TTL для всех связанных ключей
          await this.updateTTL(`player:${data.telegramId}`);
          await this.updateTTL(`lobby:${playerData.lobbyId}`);

          // Если есть активная игра, обновляем и её TTL
          const gameData = await this.getFromRedis(`game:${playerData.lobbyId}`);
          if (gameData) {
            await this.updateTTL(`game:${playerData.lobbyId}`);
          }

          // Обновляем статус в Redis
          await this.saveToRedis(`player:${data.telegramId}`, {
            ...playerData,
            lastAction: 'app_closed',
            timestamp: Date.now()
          });
        }
      }
    } catch (error) {
      console.error('❌ [AppClosed] Error updating TTL:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        telegramId: data.telegramId,
        timestamp: new Date().toISOString()
      });
    }
  }

  @SubscribeMessage('checkActiveLobby')
  async handleCheckActiveLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { telegramId: string }
  ) {
    try {
      const lobby = await this.gameService.findLobbyByCreator(data.telegramId);
      
      if (lobby) {
        // Получаем оставшееся время TTL
        const ttl = await this.redis.ttl(lobby.id);
        
        return {
          lobbyId: lobby.id,
          ttl: ttl > 0 ? ttl : 180, // Если TTL истек, возвращаем дефолтное значение
          status: lobby.status
        };
      }
      
      return { lobbyId: null };
    } catch (error) {
      console.error('Error checking active lobby:', error);
      return { error: 'Failed to check active lobby' };
    }
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  private async cleanupDisconnectedClients() {
    try {
      for (const [lobbyId, lobby] of this.gameService.getActiveLobbies()) {
        const exists = await this.gameService.checkLobbyInRedis(lobbyId);
        if (!exists) {
          await this.gameService.deleteLobby(lobbyId);
          // Очищаем связи
          for (const [telegramId, lid] of this.clientLobbies) {
            if (lid === lobbyId) {
              this.clientLobbies.delete(telegramId);
            }
          }
        }
      }
    } catch (error) {
      console.error('Cleanup interval error:', error);
    }
  }
}
