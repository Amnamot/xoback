// src/game/game.gateway.ts v1.0.4
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
  CancelLobbyDto,
  RestoreStateDto
} from './dto/socket.dto';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { InitDataService } from '../utils/init-data.service';

const MAX_MOVE_TIME = 30000;

// Интерфейсы для Redis
interface PlayerData {
  lobbyId?: string;
  gameId?: string;
  role: 'creator' | 'opponent';
  marker: 'o' | 'x';
  newUser?: boolean;         // Флаг нового пользователя
  inviteSent?: boolean;      // Флаг отправленного приглашения
  lastAction?: string;       // Последнее действие игрока
  timestamp?: number;        // Временная метка последнего обновления
  name?: string;            // Имя игрока из initData (firstName)
  avatar?: string;          // Аватар игрока из initData (photo_url)
}

interface LobbyData {
  creatorId: string;
  opponentId?: string;
  status: 'pending' | 'active' | 'closed';
  socketId: string;          // ID сокета, жестко связанный с лобби
}

interface GameData {
  board: string[];
  currentTurn: string;
  lastMoveTime: number;
}

interface PlayerState {
  roomId: string;  // ID комнаты (лобби или игры)
  role: 'creator' | 'opponent';
  marker: 'o' | 'x';
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
  private playerStates = new Map<string, PlayerState>(); // telegramId -> PlayerState
  private clientGames = new Map<string, string>(); // telegramId -> gameId
  private clientLobbies = new Map<string, string>(); // telegramId -> lobbyId
  private reconnectTimeouts = new Map<string, NodeJS.Timeout>(); // telegramId -> timeout
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private readonly gameService: GameService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @InjectRedis() private readonly redis: Redis,
    private readonly initDataService: InitDataService
  ) {
    console.log('WebSocket URL:', this.configService.get('SOCKET_URL'));
    
    this.cleanupInterval = setInterval(() => this.cleanupDisconnectedClients(), 60000);
  }

  // Методы для работы с Redis
  async saveToRedis(key: string, value: any, ttlSeconds: number = 180) {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    console.log('📝 [Redis] Saved data:', { key, value, ttl: ttlSeconds, timestamp: new Date().toISOString() });
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
    try {
      // Получаем данные пользователя из handshake
      const initData = this.initDataService.parseInitData(client.handshake.query.initData as string);
      if (!initData || !initData.user) {
        console.error('❌ [Connection] Invalid init data');
        client.disconnect();
        return;
      }

      console.log('🔌 [Connection] New connection:', {
        telegramId: initData.user.id,
        socketId: client.id,
        startParam: initData.start_param,
        timestamp: new Date().toISOString()
      });

      // Регистрируем клиента
      this.connectedClients.set(initData.user.id, client);
      console.log('✅ [Connection] Client registered:', {
        telegramId: initData.user.id,
        socketId: client.id,
        timestamp: new Date().toISOString()
      });

      // Если есть start_param, обрабатываем его
      if (initData.start_param) {
        console.log('🎯 [Connection] Processing start_param:', {
          startParam: initData.start_param,
          telegramId: initData.user.id,
          timestamp: new Date().toISOString()
        });

        // Сохраняем данные игрока
        await this.saveToRedis(`player:${initData.user.id}`, {
          lobbyId: initData.start_param,
          role: 'opponent',
          marker: 'o',
          newUser: false,
          name: initData.user.first_name,
          avatar: initData.user.photo_url
        });

        // Обновляем данные лобби
        const lobbyData = await this.getFromRedis(`lobby:${initData.start_param}`);
        if (lobbyData) {
          await this.saveToRedis(`lobby:${initData.start_param}`, {
            ...lobbyData,
            opponentId: initData.user.id
          });
        }

        // Подключаем к комнате лобби
        const roomId = initData.start_param.replace(/^lobby/, 'room');
        client.join(roomId);
        this.clientLobbies.set(initData.user.id, initData.start_param);

        console.log('✅ [Connection] Joined lobby via start_param:', {
          lobbyId: initData.start_param,
          telegramId: initData.user.id,
          timestamp: new Date().toISOString()
        });

        // Вызываем handleJoinLobby для полной инициализации игры
        await this.handleJoinLobby(client, {
          lobbyId: initData.start_param,
          telegramId: initData.user.id
        });
      }

      // Проверяем наличие активного лобби
      const playerData = await this.getFromRedis(`player:${initData.user.id}`);
      if (playerData?.lobbyId) {
        const lobbyData = await this.getFromRedis(`lobby:${playerData.lobbyId}`);
        if (lobbyData) {
          // Подключаем к комнате лобби
          const roomId = playerData.lobbyId.replace(/^lobby/, 'room');
          client.join(roomId);
          this.clientLobbies.set(initData.user.id, playerData.lobbyId);
        }
      }

    } catch (error) {
      console.error('❌ [Connection] Error:', error);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const telegramId = client.handshake.query.telegramId as string;
    if (!telegramId) return;

    console.log('🔌 [Disconnect] Client disconnected:', {
      telegramId,
      socketId: client.id,
      hadActiveLobby: this.clientLobbies.has(telegramId),
      wasInGame: this.clientGames.has(telegramId),
      activeConnections: this.connectedClients.size,
      timestamp: new Date().toISOString()
    });

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
          const roomId = lobbyId.replace(/^lobby/, 'room');
          this.server.to(roomId).emit('lobbyDeleted', {
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
        const roomId = gameId.replace(/^lobby/, 'room');
        this.server.to(roomId).emit('playerDisconnected', { telegramId });

        // Устанавливаем таймаут на переподключение
        const timeout = setTimeout(async () => {
          // Если игрок не переподключился за 30 секунд, завершаем игру
          const winnerId = String(session.creatorId) === String(telegramId) ? session.opponentId : session.creatorId;
          await this.gameService.endGameSession(gameId, winnerId);
          this.server.to(roomId).emit('gameEnded', {
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
      // Получаем данные пользователя из handshake
      const initData = this.initDataService.parseInitData(client.handshake.query.initData as string);
      if (!initData || !initData.user) {
        console.error('❌ [CreateLobby] Invalid init data:', {
          initData,
          timestamp: new Date().toISOString()
        });
        throw new Error('Invalid init data');
      }

      console.log('✅ [CreateLobby] User data:', {
        telegramId: initData.user.id,
        firstName: initData.user.first_name,
        photoUrl: initData.user.photo_url,
        timestamp: new Date().toISOString()
      });

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
      
      // Проверяем существование пользователя в таблице User
      const user = await this.gameService.findUserByTelegramId(data.telegramId);
      const isNewUser = !user;
      console.log('👤 [CreateLobby] User check:', {
        telegramId: data.telegramId,
        isNewUser,
        timestamp: new Date().toISOString()
      });

      // Создаем игровую сессию через GameService
      const gameSession = await this.gameService.createGameSession(lobby.id, {
        creatorId: data.telegramId,
        opponentId: '', // Пустой ID оппонента, так как он еще не подключился
        creatorMarker: 'x',
        opponentMarker: 'o',
        startTime: Date.now()
      });

      if (!gameSession) {
        console.error('❌ [CreateLobby] Failed to create game session:', {
          lobbyId: lobby.id,
          creatorId: data.telegramId,
          timestamp: new Date().toISOString()
        });
        return { 
          status: 'error',
          message: 'Failed to create game session',
          timestamp: Date.now()
        };
      }

      // Сохраняем данные игрока
      await this.saveToRedis(`player:${data.telegramId}`, {
        lobbyId: lobby.id,
        role: 'creator',
        marker: 'x',
        newUser: isNewUser,
        name: initData.user.first_name,
        avatar: initData.user.photo_url
      });

      console.log('✅ [CreateLobby] Player data saved to Redis:', {
        telegramId: data.telegramId,
        lobbyId: lobby.id,
        role: 'creator',
        marker: 'x',
        name: initData.user.first_name,
        avatar: initData.user.photo_url,
        timestamp: new Date().toISOString()
      });
      
      // Сохраняем связь клиент-лобби
      const roomId = lobby.id.replace(/^lobby/, 'room');
      this.playerStates.set(data.telegramId, {
        roomId: roomId,
        role: 'creator',
        marker: 'x'
      });
      
      // Добавляем клиента только в игровую комнату
      client.join(roomId);
      
      // Отправляем событие о готовности лобби
      this.server.to(roomId).emit('lobbyReady', { 
        lobbyId: lobby.id,
        roomId: roomId,
        timestamp: Date.now(),
        creatorMarker: 'x'
      });
      
      return { 
        status: 'created', 
        lobbyId: lobby.id,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ Error in handleCreateLobby:', error);
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
      telegramId: data.telegramId, 
      lobbyId: data.lobbyId,
      socketId: client.id,
      rooms: Array.from(client.rooms),
      adapter: this.server.sockets.adapter.rooms.size
    });
    
    try {
      // Проверяем существование лобби
      const lobby = await this.gameService.getLobby(data.lobbyId);
      if (!lobby) {
        console.warn('⚠️ Lobby not found:', data.lobbyId);
        return { 
          status: 'error',
          message: 'Lobby not found',
          timestamp: Date.now()
        };
      }

      // Проверяем, не закрыто ли лобби
      if (lobby.status === 'closed') {
        console.warn('⚠️ Lobby is closed:', data.lobbyId);
        return { 
          status: 'error',
          message: 'Lobby is closed',
          timestamp: Date.now()
        };
      }

      // Проверяем существование пользователя в таблице User
      const user = await this.gameService.findUserByTelegramId(data.telegramId);
      const isNewUser = !user;
      console.log('👤 [JoinLobby] User check:', {
        telegramId: data.telegramId,
        isNewUser,
        timestamp: new Date().toISOString()
      });

      // Обновляем лобби через GameService
      await this.gameService.updateLobby(data.lobbyId, {
        opponentId: data.telegramId,
        status: 'closed'
      });

      // Проверяем, что лобби было обновлено
      const updatedLobby = await this.gameService.getLobby(data.lobbyId);
      if (!updatedLobby || updatedLobby.opponentId !== data.telegramId) {
        console.error('❌ Failed to update lobby:', data.lobbyId);
        return { 
          status: 'error',
          message: 'Failed to update lobby',
          timestamp: Date.now()
        };
      }

      // Обновляем игровую сессию
      const gameSession = await this.gameService.updateGameSession(data.lobbyId, {
        opponentId: data.telegramId,
        opponentMarker: 'o'
      });

      if (!gameSession) {
        console.error('❌ Failed to update game session:', data.lobbyId);
        return { 
          status: 'error',
          message: 'Failed to update game session',
          timestamp: Date.now()
        };
      }

      // Подготавливаем roomId
      const roomId = data.lobbyId.replace(/^lobby/, 'room');

      // Сохраняем данные игрока
      await this.saveToRedis(`player:${data.telegramId}`, {
        lobbyId: data.lobbyId,
        role: 'opponent',
        marker: 'o',
        newUser: isNewUser
      });

      // Сохраняем связь клиент-лобби
      this.playerStates.set(data.telegramId, {
        roomId: roomId,
        role: 'opponent',
        marker: 'o'
      });

      // Добавляем клиента в игровую комнату
      client.join(roomId);

      // Запускаем игру
      await this.gameService.startGame(data.lobbyId);

      // Получаем обновленную игровую сессию
      const updatedGameSession = await this.gameService.getGameSession(data.lobbyId);
      if (!updatedGameSession) {
        console.error('❌ Failed to get game session after start:', data.lobbyId);
        return { 
          status: 'error',
          message: 'Failed to get game session',
          timestamp: Date.now()
        };
      }

      // Отправляем событие начала игры
      const gameRoomId = data.lobbyId.replace(/^lobby/, 'room');
      console.log('🎮 [GameStart] Sending gameStart event:', {
        gameRoomId,
        lobbyId: data.lobbyId,
        creatorId: updatedGameSession.creatorId,
        opponentId: updatedGameSession.opponentId,
        rooms: Array.from(this.server.sockets.adapter.rooms.keys()),
        timestamp: new Date().toISOString()
      });
      
      this.server.to(gameRoomId).emit('gameStart', {
        gameId: data.lobbyId,
        lobbyId: data.lobbyId,
        startTime: Date.now(),
        creatorId: updatedGameSession.creatorId,
        opponentId: updatedGameSession.opponentId,
        creatorMarker: updatedGameSession.creatorMarker,
        opponentMarker: updatedGameSession.opponentMarker,
        currentTurn: updatedGameSession.currentTurn,
        currentPlayer: updatedGameSession.currentTurn,
        gameSession: {
          id: updatedGameSession.id,
          creatorId: updatedGameSession.creatorId,
          currentTurn: updatedGameSession.currentTurn,
          players: {
            x: {
              isCreator: true,
              moveTimer: 30000,
              time: 0,
              playerTime1: 0,
              playerTime2: 0
            },
            o: {
              isCreator: false,
              moveTimer: 30000,
              time: 0,
              playerTime1: 0,
              playerTime2: 0
            }
          }
        }
      });

      console.log('✅ [GameStart] Event sent:', {
        gameRoomId,
        timestamp: new Date().toISOString()
      });

      // Отправляем состояние игры
      this.sendGameStateToSocket(client, updatedGameSession, data.lobbyId);

      console.log('✅ [GameState] Event sent:', {
        gameRoomId,
        timestamp: new Date().toISOString()
      });

      // Отправляем событие о присоединении игрока
      this.server.to(gameRoomId).emit('playerJoined', {
        lobbyId: data.lobbyId,
        roomId: roomId,
        opponentId: data.telegramId,
        timestamp: Date.now()
      });

      return { 
        status: 'joined',
        lobbyId: data.lobbyId,
        roomId: roomId,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ Error in handleJoinLobby:', error);
      return { 
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to join lobby',
        timestamp: Date.now()
      };
    }
  }

  @SubscribeMessage('makeMove')
  @UsePipes(new ValidationPipe())
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: MakeMoveDto
  ) {
    // Получаем текущее состояние игры из Redis
    const gameData = await this.getFromRedis(`lobby:${data.gameId}`);
    if (!gameData) {
      return { status: 'error', message: 'Game session not found' };
    }

    const currentTime = Date.now();
    const timeSinceLastMove = currentTime - gameData.lastMoveTime;

    if (timeSinceLastMove > MAX_MOVE_TIME) {
      const winner = gameData.currentTurn === String(gameData.creatorId) ? gameData.opponentId : gameData.creatorId;
      
      // Очищаем данные игры из Redis
      await this.redis.del(`lobby:${data.gameId}`);
      
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
    newBoard[Number(data.position)] = data.player === String(gameData.creatorId) ? 'x' : 'o';

    const updatedGameData = {
      ...gameData,
      board: newBoard,
      lastMoveTime: currentTime,
      currentTurn: data.player === String(gameData.creatorId) ? gameData.opponentId : gameData.creatorId
    };

    // Сохраняем обновленное состояние в Redis
    await this.saveToRedis(`lobby:${data.gameId}`, updatedGameData);

    // Обновляем TTL для всех связанных ключей
    await this.updateTTL(`lobby:${data.gameId}`);
    await this.updateTTL(`player:${data.player}`);

    const roomId = data.gameId.replace(/^lobby/, 'room');
    this.server.to(roomId).emit('moveMade', {
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
    const gameData = await this.getFromRedis(`lobby:${data.gameId}`);
    if (!gameData) {
      return { status: 'error', message: 'Game session not found' };
    }

    // Обновляем время игроков
    const updatedGameData = {
      ...gameData,
      creatorTime: data.playerTimes.playerTime1,
      opponentTime: data.playerTimes.playerTime2,
      lastAction: 'time_update',
      timestamp: Date.now()
    };

    // Сохраняем обновленные данные
    await this.saveToRedis(`lobby:${data.gameId}`, updatedGameData);

    // Отправляем обновленное время всем игрокам
    const roomId = data.gameId.replace(/^lobby/, 'room');
    this.server.to(roomId).emit('timeUpdated', {
      playerTime1: updatedGameData.creatorTime,
      playerTime2: updatedGameData.opponentTime
    });

    return { status: 'success' };
  }

  @SubscribeMessage('gameOver')
  @UsePipes(new ValidationPipe())
  async handleGameOver(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: GameOverDto
  ) {
    const gameData = await this.getFromRedis(`lobby:${data.gameId}`);
    if (!gameData) {
      return { status: 'error', message: 'Game session not found' };
    }

    // Обновляем статус игры
    const updatedGameData = {
      ...gameData,
      status: 'finished',
      winner: data.winner,
      lastAction: 'game_over',
      timestamp: Date.now()
    };

    // Сохраняем финальное состояние
    await this.saveToRedis(`lobby:${data.gameId}`, updatedGameData);

    // Отправляем событие окончания игры
    const roomId = data.gameId.replace(/^lobby/, 'room');
    this.server.to(roomId).emit('gameEnded', { 
      winner: data.winner,
      statistics: {
        totalTime: Math.floor((Date.now() - gameData.startTime) / 1000),
        moves: gameData.board.filter((cell: string) => cell !== '').length,
        playerTime1: gameData.creatorTime,
        playerTime2: gameData.opponentTime
      }
    });
    
    // Очищаем связи клиент-игра
    this.clientGames.delete(gameData.creatorId);
    this.clientGames.delete(gameData.opponentId);

    return { status: 'success' };
  }

  @SubscribeMessage('joinGame')
  @UsePipes(new ValidationPipe())
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinGameDto
  ) {
    this.clientGames.set(data.telegramId, data.gameId);
    const roomId = data.gameId.replace(/^lobby/, 'room');
    client.join(roomId);
    
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

    const winner = String(session.creatorId) === String(data.player) ? session.opponentId : session.creatorId;

    await this.gameService.endGameSession(data.gameId, winner);

    const roomId = data.gameId.replace(/^lobby/, 'room');
    this.server.to(roomId).emit('gameEnded', {
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
    console.log('🔍 [Invite] Starting invite creation for telegramId:', {
      telegramId: data.telegramId,
      socketId: client.id,
      clientRooms: Array.from(client.rooms || []),
      timestamp: new Date().toISOString()
    });
    
    try {
      // Проверяем состояние Redis перед поиском лобби
      const redisState = await Promise.all([
        this.redis.keys('lobby_*'),
        this.redis.keys('user_lobby:*'),
        this.redis.keys('player:*')
      ]);
      
      console.log('🔍 [Invite] Redis state before lobby search:', {
        lobbies: redisState[0],
        userLobbies: redisState[1],
        players: redisState[2],
        timestamp: new Date().toISOString()
      });

      // Получаем лобби из GameService
      let lobby = await this.gameService.findLobbyByCreator(data.telegramId);
      
      if (!lobby) {
        console.log('❌ [Invite] No matching lobby found for telegramId:', {
          telegramId: data.telegramId,
          timestamp: new Date().toISOString(),
          redisState: {
            lobbies: redisState[0],
            userLobbies: redisState[1],
            players: redisState[2]
          }
        });

        // Пробуем создать новое лобби, если не найдено
        console.log('🔄 [Invite] Attempting to create new lobby for creator:', {
          telegramId: data.telegramId,
          timestamp: new Date().toISOString()
        });

        const newLobby = await this.gameService.createLobby(data.telegramId);
        if (!newLobby) {
          console.error('❌ [Invite] Failed to create new lobby:', {
            telegramId: data.telegramId,
            timestamp: new Date().toISOString()
          });
          return { error: 'Failed to create lobby' };
        }

        console.log('✅ [Invite] Created new lobby:', {
          lobbyId: newLobby.id,
          creatorId: data.telegramId,
          timestamp: new Date().toISOString()
        });

        // Используем новое лобби
        lobby = newLobby;
      }

      console.log('✅ [Invite] Found lobby:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        clientRooms: Array.from(client.rooms || []),
        timestamp: new Date().toISOString(),
        lobbyData: await this.redis.get(lobby.id),
        userLobbyData: await this.redis.get(`user_lobby:${data.telegramId}`)
      });

      // Получаем текущие данные лобби
      const lobbyData = await this.getFromRedis(`lobby:${lobby.id}`);
      
      if (!lobbyData) {
        console.error('❌ [Invite] Lobby data not found in Redis:', {
          lobbyId: lobby.id,
          creatorId: data.telegramId,
          timestamp: new Date().toISOString()
        });
        return { error: 'Lobby data not found' };
      }

      // Обновляем данные лобби
      await this.saveToRedis(`lobby:${lobby.id}`, {
        ...lobbyData,
        inviteSent: true,
        lastAction: 'invite_sent',
        timestamp: Date.now()
      });

      // Проверяем членство в комнате перед сохранением в Redis
      console.log('🔍 [Invite] Room membership check before Redis:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        inRoom: client.rooms.has(lobby.id),
        allRooms: Array.from(client.rooms || []),
        timestamp: new Date().toISOString()
      });

      // Сохраняем данные в Redis
      const existingPlayerData = await this.getFromRedis(`player:${data.telegramId}`);
      const isNewUser = !existingPlayerData;
      await this.saveToRedis(`player:${data.telegramId}`, {
        ...existingPlayerData,
        lobbyId: lobby.id,
        role: 'creator',
        marker: 'x',
        newUser: isNewUser
      });
      console.log('[DEBUG][PLAYER SAVE]', {
        telegramId: data.telegramId,
        lobbyId: lobby.id,
        role: 'creator',
        marker: 'x',
        source: 'handleCreateInvite',
        timestamp: new Date().toISOString()
      });

      // Проверяем членство в комнате после сохранения в Redis
      console.log('🔍 [Invite] Room membership check after Redis:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        inRoom: client.rooms.has(lobby.id),
        allRooms: Array.from(client.rooms || []),
        timestamp: new Date().toISOString()
      });

      // Если создатель не в комнате, добавляем его
      const roomId = lobby.id.replace(/^lobby/, 'room');
      if (!client.rooms.has(roomId)) {
        console.log('⚠️ [Invite] Creator not in room, rejoining:', {
          lobbyId: lobby.id,
          roomId: roomId,
          creatorId: data.telegramId,
          timestamp: new Date().toISOString()
        });
        
        client.join(roomId);
        
        console.log('✅ [Invite] Creator rejoined room:', {
          lobbyId: lobby.id,
          roomId: roomId,
          creatorId: data.telegramId,
          newRooms: Array.from(client.rooms || []),
          timestamp: new Date().toISOString()
        });
      }

      console.log('🎯 [Invite] Lobby state after invite:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        lobbyStatus: lobby.status,
        creatorMarker: 'x',
        redisKeys: {
          player: `player:${data.telegramId}`,
          lobby: `lobby:${lobby.id}`
        },
        clientState: {
          inClientGames: this.clientGames.has(data.telegramId),
          inClientLobbies: this.clientLobbies.has(data.telegramId),
          inConnectedClients: this.connectedClients.has(data.telegramId),
          rooms: Array.from(client.rooms || [])
        },
        timestamp: new Date().toISOString()
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
      const roomId = lobby.id.replace(/^lobby/, 'room');
      console.log('📢 Broadcasting lobbyDeleted event to room:', roomId);
      this.server.to(roomId).emit('lobbyDeleted', {
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
    @MessageBody() data: { state: 'loader' | 'startScreen' | 'waitModal' | 'loss' | 'appClosed' | 'minimized' | 'expanded', telegramId: string, details?: any }
  ) {
    console.log('📱 [WebApp] State change:', {
      telegramId: data.telegramId,
      socketId: client.id,
      previousState: client.data?.lastState || 'unknown',
      newState: data.state,
      details: data.details,
      connectionState: {
        inClientGames: this.clientGames.has(data.telegramId),
        inClientLobbies: this.clientLobbies.has(data.telegramId),
        inConnectedClients: this.connectedClients.has(data.telegramId)
      },
      timestamp: new Date().toISOString()
    });

    // Сохраняем состояние в данных сокета
    client.data = { ...client.data, lastState: data.state };

    try {
      // Если это состояние loader, сохраняем данные пользователя в Redis
      if (data.state === 'loader') {
        const { user } = this.initDataService.parseInitData(client.handshake.query.initData as string);
        if (user) {
          const existingData = await this.getFromRedis(`player:${data.telegramId}`);
          await this.saveToRedis(`player:${data.telegramId}`, {
            ...existingData,
            name: user.first_name,
            avatar: user.photo_url
          });
          console.log('✅ [WebApp] Saved user data to Redis:', {
            telegramId: data.telegramId,
            existingData,
            newData: {
              name: user.first_name,
              avatar: user.photo_url
            },
            timestamp: new Date().toISOString()
          });
        }
      }

      // Получаем данные игрока
      const playerData = await this.getFromRedis(`player:${data.telegramId}`);
      
      if (playerData?.lobbyId) {
        console.log('🎮 [WebApp] Player game state:', {
          telegramId: data.telegramId,
          appState: data.state,
          playerData,
          timestamp: new Date().toISOString()
        });

        // При сворачивании или разворачивании приложения
        if (data.state === 'minimized' || data.state === 'expanded') {
          console.log('🔄 [WebApp] View state change:', {
            telegramId: data.telegramId,
            action: data.state,
            lobbyId: playerData.lobbyId,
            role: playerData.role,
            timestamp: new Date().toISOString()
          });

          // Обновляем TTL для всех связанных ключей
          await this.updateTTL(`player:${data.telegramId}`);
          await this.updateTTL(`lobby:${playerData.lobbyId}`);

          // Проверяем наличие активной игры
          const roomIdUi = playerData.lobbyId.replace(/^lobby/, 'room');
          const gameDataUi = await this.getFromRedis(`game:${roomIdUi}`);
          if (gameDataUi) {
            console.log('🎲 [WebApp] Active game check:', {
              lobbyId: playerData.lobbyId,
              hasGameData: true,
              currentTurn: gameDataUi.currentTurn,
              isPlayerTurn: gameDataUi.currentTurn === data.telegramId,
              timestamp: new Date().toISOString()
            });

            await this.updateTTL(`game:${roomIdUi}`);
          }

          // Обновляем статус в Redis
          await this.saveToRedis(`player:${data.telegramId}`, {
            ...playerData,
            lastAction: data.state,
            timestamp: Date.now()
          });

          console.log('✅ [WebApp] State updated:', {
            telegramId: data.telegramId,
            state: data.state,
            lobbyId: playerData.lobbyId,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      console.error('❌ [WebApp] Error handling state change:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        telegramId: data.telegramId,
        state: data.state,
        timestamp: new Date().toISOString()
      });
    }
  }

  @SubscribeMessage('checkActiveLobby')
  @UsePipes(new ValidationPipe())
  async handleCheckActiveLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { telegramId: string }
  ) {
    console.log('🔍 [ActiveLobby] Checking active lobby:', {
      telegramId: data.telegramId,
      existingLobbies: Array.from(this.clientLobbies.entries()),
      existingGames: Array.from(this.clientGames.entries()),
      timestamp: new Date().toISOString()
    });

    const lobbyId = this.clientLobbies.get(data.telegramId);

    if (lobbyId) {
      console.log('📊 [ActiveLobby] Redis state:', {
        telegramId: data.telegramId,
        playerData: await this.getFromRedis(`player:${data.telegramId}`),
        lobbyData: await this.getFromRedis(`lobby:${lobbyId}`),
        gameData: await this.getFromRedis(`game:${lobbyId}`),
        timestamp: new Date().toISOString()
      });
    }

    return { lobbyId };
  }

  @SubscribeMessage('getOpponentInfo')
  async handleGetOpponentInfo(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { telegramId: string }
  ) {
    const playerData = await this.getFromRedis(`player:${data.telegramId}`);
    if (!playerData?.lobbyId) return { error: 'No lobby found' };

    const lobbyData = await this.getFromRedis(`lobby:${playerData.lobbyId}`);
    if (!lobbyData) return { error: 'No lobby data' };

    let opponentId: string | undefined;
    if (String(lobbyData.creatorId) === String(data.telegramId)) {
      opponentId = lobbyData.opponentId;
    } else {
      opponentId = lobbyData.creatorId;
    }

    if (!opponentId) return { error: 'No opponent yet' };

    const opponentData = await this.getFromRedis(`player:${opponentId}`);
    if (!opponentData) return { error: 'No opponent data' };

    const result = {
      name: opponentData.name || 'Opponent',
      avatar: opponentData.avatar || null
    };
    console.log('🟢 [getOpponentInfo] Returning opponent data:', { telegramId: data.telegramId, opponentId, result, timestamp: new Date().toISOString() });
    return result;
  }

  @SubscribeMessage('restoreState')
  @UsePipes(new ValidationPipe())
  async handleRestoreState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: RestoreStateDto
  ) {
    try {
      console.log('🔄 [RestoreState] Attempting to restore state:', {
        telegramId: data.telegramId,
        lastKnownState: data.lastKnownState,
        lastActionTimestamp: data.lastActionTimestamp,
        timestamp: new Date().toISOString()
      });

      // Получаем все данные игрока
      const playerData = await this.getFromRedis(`player:${data.telegramId}`);
      if (!playerData) {
        console.log('❌ [RestoreState] No player data found:', {
          telegramId: data.telegramId,
          timestamp: new Date().toISOString()
        });
        return { status: 'error', message: 'No player data found' };
      }

      // Проверяем наличие активной игры
      if (playerData.gameId) {
        const gameData = await this.getFromRedis(`game:${playerData.gameId}`);
        if (gameData) {
          console.log('🎮 [RestoreState] Restoring active game:', {
            telegramId: data.telegramId,
            gameId: playerData.gameId,
            timestamp: new Date().toISOString()
          });

          // Подключаем к комнате игры
          const roomId = playerData.gameId.replace(/^lobby/, 'room');
          client.join(roomId);
          this.clientGames.set(data.telegramId, playerData.gameId);

          // Отправляем текущее состояние игры
          this.sendGameStateToSocket(client, gameData, playerData.gameId);

          return {
            status: 'success',
            state: 'game',
            gameData: {
              board: gameData.board,
              currentTurn: gameData.currentTurn,
              playerTime1: gameData.playerTime1,
              playerTime2: gameData.playerTime2,
              startTime: gameData.startTime,
              lastMoveTime: gameData.lastMoveTime
            }
          };
        }
      }

      // Проверяем наличие активного лобби
      if (playerData.lobbyId) {
        const lobbyData = await this.getFromRedis(`lobby:${playerData.lobbyId}`);
        if (lobbyData) {
          console.log('🎯 [RestoreState] Restoring active lobby:', {
            telegramId: data.telegramId,
            lobbyId: playerData.lobbyId,
            timestamp: new Date().toISOString()
          });

          // Подключаем к комнате лобби
          const roomId = playerData.lobbyId.replace(/^lobby/, 'room');
          client.join(roomId);
          this.clientLobbies.set(data.telegramId, playerData.lobbyId);

          // Обновляем TTL для всех ключей
          await this.updateTTL(`player:${data.telegramId}`);
          await this.updateTTL(`lobby:${playerData.lobbyId}`);

          return {
            status: 'success',
            state: 'lobby',
            lobbyData: {
              lobbyId: playerData.lobbyId,
              role: playerData.role,
              marker: playerData.marker,
              inviteSent: playerData.inviteSent
            }
          };
        }
      }

      // Если нет активной игры или лобби, возвращаем базовое состояние
      return {
        status: 'success',
        state: 'idle',
        playerData: {
          name: playerData.name,
          avatar: playerData.avatar
        }
      };

    } catch (error) {
      console.error('❌ [RestoreState] Error restoring state:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        telegramId: data.telegramId,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to restore state'
      };
    }
  }

  @SubscribeMessage('getInitialState')
  async handleGetInitialState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { telegramId: string }
  ) {
    try {
      const { telegramId } = data;
      console.log('🎮 [GetInitialState] Request received:', {
        telegramId,
        socketId: client.id,
        timestamp: new Date().toISOString()
      });

      // Получаем данные игрока из Redis
      const playerData = await this.getFromRedis(`player:${telegramId}`);
      if (playerData?.lobbyId) {
        // Отправляем lobbyId клиенту
        client.emit('lobbyIdReceived', { lobbyId: playerData.lobbyId });
        console.log('✅ [GetInitialState] LobbyId sent:', {
          lobbyId: playerData.lobbyId,
          telegramId,
          socketId: client.id,
          timestamp: new Date().toISOString()
        });
      }

      // Если есть активная игра, отправляем её состояние
      if (playerData.gameId) {
        const gameData = await this.getFromRedis(`game:${playerData.gameId}`);
        if (gameData) {
          console.log('🎮 [InitialState] Found active game:', {
            telegramId,
            gameId: playerData.gameId,
            timestamp: new Date().toISOString()
          });

          // Подключаем к комнате игры
          const roomId = playerData.gameId.replace(/^lobby/, 'room');
          client.join(roomId);
          this.clientGames.set(telegramId, playerData.gameId);

          // Отправляем текущее состояние игры
          this.sendGameStateToSocket(client, gameData, playerData.gameId);

          return {
            status: 'success',
            state: 'game',
            gameData: {
              board: gameData.board,
              currentTurn: gameData.currentTurn,
              playerTime1: gameData.playerTime1,
              playerTime2: gameData.playerTime2,
              startTime: gameData.startTime,
              lastMoveTime: gameData.lastMoveTime
            }
          };
        }
      }

      // Если нет активной игры, отправляем начальное состояние
      return {
        status: 'success',
        state: 'waiting',
        gameData: {
          board: Array(10000).fill(null),
          currentTurn: 'x',
          playerTime1: 0,
          playerTime2: 0,
          startTime: Date.now(),
          lastMoveTime: Date.now()
        }
      };
    } catch (error) {
      console.error('❌ [GetInitialState] Error:', {
        error: error.message,
        telegramId: data.telegramId,
        socketId: client.id,
        timestamp: new Date().toISOString()
      });
      client.emit('error', { message: error.message });
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
              // Отправляем событие в правильную комнату
              const roomId = lobbyId.replace(/^lobby/, 'room');
              this.server.to(roomId).emit('lobbyDeleted', {
                reason: 'Lobby expired',
                timestamp: Date.now()
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Cleanup interval error:', error);
    }
  }

  /**
   * Отправляет актуальное состояние игры конкретному сокету
   */
  private async sendGameStateToSocket(socket: Socket, gameSession: any, lobbyId: string) {
    if (!gameSession) {
      console.log('⚠️ [GameGateway] Cannot send game state: gameSession is null', {
        socketId: socket.id,
        lobbyId,
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Получаем данные игроков из Redis
    const creatorData = await this.getFromRedis(`player:${gameSession.creatorId}`);
    const opponentData = await this.getFromRedis(`player:${gameSession.opponentId}`);

    console.log('🎮 [GameState] Sending game state with player data:', {
      creatorId: gameSession.creatorId,
      opponentId: gameSession.opponentId,
      creatorData,
      opponentData,
      timestamp: new Date().toISOString()
    });

    socket.emit('gameState', {
      board: gameSession.board,
      currentPlayer: gameSession.currentTurn,
      scale: 1,
      position: { x: 0, y: 0 },
      time: 0,
      playerTime1: gameSession.playerTime1,
      playerTime2: gameSession.playerTime2,
      startedAt: gameSession.startedAt,
      lastMoveTime: gameSession.lastMoveTime,
      maxMoveTime: MAX_MOVE_TIME,
      gameSession: {
        id: gameSession.id,
        creatorId: gameSession.creatorId,
        opponentId: gameSession.opponentId,
        lobbyId: lobbyId,
        players: {
          creator: {
            name: creatorData?.name || 'Creator',
            avatar: creatorData?.avatar || null
          },
          opponent: {
            name: opponentData?.name || 'Opponent',
            avatar: opponentData?.avatar || null
          }
        }
      }
    });
    console.log('[DEBUG][SOCKET][AUTO_SEND_GAMESTATE_ON_JOIN]', {
      to: socket.id,
      gameSessionId: gameSession.id,
      lobbyId,
      timestamp: new Date().toISOString()
    });
  }
}
