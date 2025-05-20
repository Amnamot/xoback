// src/game/game.gateway.ts v1.0.0
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
import { Redis } from 'ioredis';

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
    
    // Запускаем периодическую очистку неактивных лобби
    this.cleanupInterval = setInterval(async () => {
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
    }, 30000); // каждые 30 секунд
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

    // Очищаем таймер на удаление лобби, если он есть
    const disconnectTimeout = this.reconnectTimeouts.get(telegramId);
    if (disconnectTimeout) {
      clearTimeout(disconnectTimeout);
      this.reconnectTimeouts.delete(telegramId);
      
      // Проверяем и восстанавливаем лобби
      const lobby = await this.gameService.findLobbyByCreator(telegramId);
      if (lobby && lobby.status === 'pending') {
        await this.gameService.restoreLobby(lobby.id);
        
        // Получаем оставшееся время TTL для pending статуса
        const pendingTTL = await this.redis.ttl(`pending:${lobby.id}`);
        const ttl = pendingTTL > 0 ? pendingTTL : 30;

        // Сначала присоединяем клиента к комнате
        client.join(lobby.id);
        
        // Затем отправляем событие показа WaitModal
        client.emit('setShowWaitModal', {
          show: true,
          ttl: ttl
        });
        
        // И только потом отправляем событие о готовности лобби
        this.server.to(lobby.id).emit('lobbyReady', { 
          lobbyId: lobby.id,
          timestamp: Date.now(),
          ttl: ttl
        });

        console.log('🔄 Restored lobby and sent ready event:', {
          lobbyId: lobby.id,
          creatorId: telegramId,
          rooms: Array.from(client.rooms),
          status: lobby.status,
          pendingTTL: ttl
        });
      }
    }

    this.connectedClients.set(telegramId, client);
    
    // Проверяем, есть ли активная игра
    const gameId = this.clientGames.get(telegramId);
    if (gameId) {
      try {
        const session = await this.gameService.getGameSession(gameId);
        if (!session) {
          // Если сессия не найдена, проверяем, не закончилась ли игра
          const gameResult = await this.gameService.getGameResult(gameId);
          if (gameResult) {
            client.emit('showGameResult', {
              result: gameResult.winner === telegramId ? 'win' : 'loss',
              reason: gameResult.reason,
              statistics: gameResult.statistics
            });
            // Очищаем связь с игрой
            this.clientGames.delete(telegramId);
            return;
          }
        } else {
          const currentTime = Date.now();
          const timeSinceLastMove = currentTime - session.lastMoveTime;
          const MAX_MOVE_TIME = 30000; // 30 секунд на ход

          // Если это был ход отключившегося игрока и время истекло
          if (session.currentTurn === telegramId && timeSinceLastMove > MAX_MOVE_TIME) {
            // Определяем победителя (противник отключившегося)
            const winner = session.currentTurn === session.creatorId ? session.opponentId : session.creatorId;
            
            // Завершаем игру
            await this.gameService.endGameSession(gameId, winner, 'timeout_on_reconnect');
            
            // Отправляем результат переподключившемуся игроку
            client.emit('showGameResult', {
              result: 'loss',
              reason: 'timeout_on_reconnect',
              statistics: {
                totalTime: Math.floor((currentTime - session.startedAt) / 1000),
                moves: session.numMoves,
                playerTime1: session.playerTime1,
                playerTime2: session.playerTime2,
                lastMoveTime: timeSinceLastMove
              }
            });

            // Уведомляем оппонента
            this.server.to(gameId).emit('gameEnded', {
              winner,
              reason: 'timeout_on_reconnect',
              statistics: {
                totalTime: Math.floor((currentTime - session.startedAt) / 1000),
                moves: session.numMoves,
                playerTime1: session.playerTime1,
                playerTime2: session.playerTime2,
                lastMoveTime: timeSinceLastMove
              }
            });

            // Очищаем связи с игрой
            this.clientGames.delete(session.creatorId);
            this.clientGames.delete(session.opponentId);
          } else {
            // Если время не истекло или это не ход отключившегося - продолжаем игру
            client.join(gameId);
            this.server.to(gameId).emit('playerReconnected', {
              telegramId,
              gameState: {
                ...session,
                serverTime: currentTime,
                timeLeft: Math.max(0, MAX_MOVE_TIME - timeSinceLastMove) // оставшееся время хода
              }
            });
          }
        }
      } catch (error) {
        console.error('Error reconnecting to game:', error);
        this.clientGames.delete(telegramId);
      }
    }
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
        timestamp: Date.now()
      });
      console.log('📢 Lobby ready event emitted:', { 
        lobbyId: lobby.id,
        roomSize: this.server.sockets.adapter.rooms.get(lobby.id)?.size || 0,
        activeConnections: this.server.sockets.sockets.size
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

    console.log('✅ Lobby found:', {
      lobbyId: lobby.id,
      creatorId: lobby.creatorId,
      status: lobby.status,
      timestamp: new Date().toISOString(),
      joiningPlayer: data.telegramId,
      socketId: client.id
    });

    if (lobby.status === 'pending') {
      // Проверяем, подключен ли создатель
      const creatorSocket = this.connectedClients.get(lobby.creatorId);
      if (!creatorSocket || !creatorSocket.connected) {
        // Получаем оставшееся время TTL
        const ttl = await this.redis.ttl(lobby.id);
        console.warn('⚠️ Creator disconnected:', {
          lobbyId: lobby.id,
          creatorId: lobby.creatorId,
          ttl: ttl,
          timestamp: new Date().toISOString(),
          joiningPlayer: data.telegramId,
          socketId: client.id,
          creatorSocketId: creatorSocket?.id
        });
        return { 
          status: 'error',
          errorType: 'disconnected',
          ttl: ttl > 0 ? ttl : 30,
          message: 'Lobby creator is currently disconnected.<br />We are waiting for his connection'
        };
      }
    }

    if (lobby.creatorId === data.telegramId) {
      console.log('👑 Creator joining their own lobby:', {
        lobbyId: lobby.id,
        creatorId: data.telegramId,
        timestamp: new Date().toISOString(),
        socketId: client.id,
        clientRooms: Array.from(client.rooms)
      });
      client.join(data.lobbyId);
      return { status: 'creator' };
    }

    try {
      console.log('🎲 Creating game session:', {
        lobbyId: data.lobbyId,
        creatorId: lobby.creatorId,
        opponentId: data.telegramId,
        timestamp: new Date().toISOString(),
        socketId: client.id,
        creatorSocket: this.connectedClients.get(lobby.creatorId)?.id
      });

      // Создаем игровую сессию
      const session = await this.gameService.createGameSession(data.lobbyId, data.telegramId);
      client.join(data.lobbyId);
      
      // Сохраняем связь игроков с игрой
      this.clientGames.set(lobby.creatorId, data.lobbyId);
      this.clientGames.set(data.telegramId, data.lobbyId);
      
      // Очищаем связь с лобби
      this.clientLobbies.delete(lobby.creatorId);

      console.log('✨ Game session created:', {
        sessionId: session.id,
        lobbyId: data.lobbyId,
        creatorId: lobby.creatorId,
        opponentId: data.telegramId,
        timestamp: new Date().toISOString(),
        roomSize: this.server.sockets.adapter.rooms.get(data.lobbyId)?.size || 0,
        creatorSocketId: this.connectedClients.get(lobby.creatorId)?.id,
        opponentSocketId: client.id
      });
      
      // Уведомляем обоих игроков о начале игры
      this.server.to(data.lobbyId).emit('gameStart', {
        creator: lobby.creatorId,
        opponent: data.telegramId,
        session
      });

      console.log('🚀 Game started:', {
        sessionId: session.id,
        lobbyId: data.lobbyId,
        roomSize: this.server.sockets.adapter.rooms.get(data.lobbyId)?.size || 0,
        timestamp: new Date().toISOString(),
        creatorSocketId: this.connectedClients.get(lobby.creatorId)?.id,
        opponentSocketId: client.id,
        activeConnections: this.connectedClients.size,
        activeGames: this.clientGames.size
      });

      return { status: 'joined' };
    } catch (error) {
      console.error('❌ Error joining lobby:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        lobbyId: data.lobbyId,
        telegramId: data.telegramId,
        timestamp: new Date().toISOString(),
        socketId: client.id,
        clientRooms: Array.from(client.rooms)
      });
      
      return {
        status: 'error',
        errorType: 'join_failed',
        message: 'Failed to join the game. Please try again.'
      };
    }
  }

  @SubscribeMessage('makeMove')
  @UsePipes(new ValidationPipe())
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: MakeMoveDto
  ) {
    const session = await this.gameService.getGameSession(data.gameId);
    
    if (!session) {
      return { status: 'error', message: 'Game session not found' };
    }

    const currentTime = Date.now();
    const timeSinceLastMove = currentTime - session.lastMoveTime;
    const MAX_MOVE_TIME = 30000;

    if (timeSinceLastMove > MAX_MOVE_TIME) {
      const winner = session.currentTurn === session.creatorId ? session.opponentId : session.creatorId;
      
      await this.gameService.endGameSession(data.gameId, winner);
      
      this.server.to(data.gameId).emit('gameEnded', {
        winner,
        reason: 'timeout',
        statistics: {
          totalTime: Math.floor((currentTime - session.startedAt) / 1000),
          moves: session.numMoves,
          playerTime1: session.playerTime1,
          playerTime2: session.playerTime2,
          lastMoveTime: timeSinceLastMove
        }
      });

      this.clientGames.delete(session.creatorId);
      this.clientGames.delete(session.opponentId);

      return { status: 'error', message: 'Move time expired' };
    }

    const isCreator = data.player === session.creatorId;

    if (data.player !== session.currentTurn) {
      return { status: 'error', message: 'Not your turn' };
    }

    const updatedSession = await this.gameService.updateGameSession(data.gameId, {
      playerTime1: isCreator ? session.playerTime1 + data.moveTime : session.playerTime1,
      playerTime2: !isCreator ? session.playerTime2 + data.moveTime : session.playerTime2,
      lastMoveTime: currentTime,
      currentTurn: isCreator ? session.opponentId : session.creatorId,
      numMoves: session.numMoves + 1
    });

    this.server.to(data.gameId).emit('moveMade', {
      moveId: `move_${currentTime}`,
      position: data.position,
      player: data.player,
      gameState: {
        currentTurn: updatedSession.currentTurn,
        playerTime1: updatedSession.playerTime1,
        playerTime2: updatedSession.playerTime2,
        numMoves: updatedSession.numMoves,
        serverTime: currentTime,
        moveStartTime: currentTime,
        gameStartTime: session.startedAt,
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

      console.log('📤 Preparing Telegram API request:', {
        result,
        timestamp: new Date().toISOString()
      });

      // Отправляем сообщение через Telegram Bot API
      const BOT_TOKEN = this.configService.get("BOT_TOKEN");
      const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/savePreparedInlineMessage`;
      const url = `${apiUrl}?user_id=${data.telegramId}&result=${encodeURIComponent(JSON.stringify(result))}&allow_user_chats=true&allow_group_chats=true`;
      
      console.log('🔗 Telegram API URL (without token):', url.replace(BOT_TOKEN, 'BOT_TOKEN'));

      const { data: response } = await firstValueFrom(this.httpService.get(url));
      
      console.log('📨 Telegram API response:', {
        response,
        timestamp: new Date().toISOString()
      });

      return { 
        messageId: response.result.id, 
        lobbyId: lobby.id 
      };
    } catch (error) {
      console.error('❌ Error creating invite:', error);
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
      console.error('❌ Error in handleCancelLobby:', {
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
      'startScreen': '🎮 User on Start screen',
      'waitModal': '⏳ WaitModal is shown',
      'loss': '❌ User on Loss screen',
      'appClosed': '👋 User closed the app'
    };

    console.log(`${states[data.state] || '🔄 UI State change'}:`, {
      telegramId: data.telegramId,
      socketId: client.id,
      state: data.state,
      ...(data.details && { details: data.details })
    });
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
}
