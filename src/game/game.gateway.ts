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
import { Server } from 'socket.io';
import { Injectable, Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameService } from './game.service';
import { SocketWithAuth } from './types/socket.types';
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
  UpdateLobbyStatusDto
} from './dto/socket.dto';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';

@Injectable()
@WebSocketGateway({
  namespace: '/game',
  cors: {
    origin: '*',
  }
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(GameGateway.name);
  private connectedClients = new Map<string, SocketWithAuth>();
  private clientGames = new Map<string, string>();
  private clientLobbies = new Map<string, string>();
  private reconnectTimeouts = new Map<string, NodeJS.Timeout>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private readonly gameService: GameService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.logger.log('GameGateway initialized');
    
    this.cleanupInterval = setInterval(async () => {
      try {
        for (const [lobbyId, lobby] of this.gameService.getActiveLobbies()) {
          const exists = await this.gameService.checkLobbyInRedis(lobbyId);
          if (!exists) {
            await this.gameService.deleteLobby(lobbyId);
            for (const [telegramId, lid] of this.clientLobbies) {
              if (lid === lobbyId) {
                this.clientLobbies.delete(telegramId);
              }
            }
          }
        }
      } catch (error) {
        this.logger.error('Cleanup interval error:', error);
      }
    }, 30000);
  }

  async handleConnection(client: SocketWithAuth) {
    try {
      const telegramId = client.telegramId;
      
      this.logger.log({
        event: 'clientConnected',
        clientId: client.id,
        telegramId,
        username: client.username,
        timestamp: new Date().toISOString()
      });

      this.connectedClients.set(telegramId, client);

      // Проверяем и восстанавливаем состояние
      const disconnectTimeout = this.reconnectTimeouts.get(telegramId);
      if (disconnectTimeout) {
        clearTimeout(disconnectTimeout);
        this.reconnectTimeouts.delete(telegramId);
        
        const lobby = await this.gameService.findLobbyByCreator(telegramId);
        if (lobby && lobby.status === 'pending') {
          await this.gameService.restoreLobby(lobby.id);
          const pendingTTL = await this.redis.ttl(`pending:${lobby.id}`);
          const ttl = pendingTTL > 0 ? pendingTTL : 30;

          client.join(lobby.id);
          client.emit('setShowWaitModal', { show: true, ttl });
          this.server.to(lobby.id).emit('lobbyReady', { 
            lobbyId: lobby.id,
            timestamp: Date.now(),
            ttl
          });

          this.logger.log({
            event: 'lobbyRestored',
            lobbyId: lobby.id,
            creatorId: telegramId,
            status: lobby.status,
            ttl
          });
        }
      }

      // Проверяем активную игру
      const gameId = this.clientGames.get(telegramId);
      if (gameId) {
        await this.handleActiveGame(client, gameId);
      }
    } catch (error) {
      this.logger.error({
        event: 'connectionError',
        error: error.message,
        stack: error.stack,
        clientId: client.id,
        timestamp: new Date().toISOString()
      });
    }
  }

  private async handleActiveGame(client: SocketWithAuth, gameId: string) {
    try {
      const session = await this.gameService.getGameSession(gameId);
      if (!session) {
        const gameResult = await this.gameService.getGameResult(gameId);
        if (gameResult) {
          client.emit('showGameResult', {
            result: gameResult.winner === client.telegramId ? 'win' : 'loss',
            reason: gameResult.reason,
            statistics: gameResult.statistics
          });
          this.clientGames.delete(client.telegramId);
        }
        return;
      }

      const currentTime = Date.now();
      const timeSinceLastMove = currentTime - session.lastMoveTime;
      const MAX_MOVE_TIME = 30000;

      if (session.currentTurn === client.telegramId && timeSinceLastMove > MAX_MOVE_TIME) {
        const winner = session.currentTurn === session.creatorId ? session.opponentId : session.creatorId;
        await this.gameService.endGameSession(gameId, winner, 'timeout_on_reconnect');
        
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

        this.clientGames.delete(session.creatorId);
        this.clientGames.delete(session.opponentId);
      } else {
        client.join(gameId);
        this.server.to(gameId).emit('playerReconnected', {
          telegramId: client.telegramId,
          gameState: {
            ...session,
            serverTime: currentTime,
            timeLeft: Math.max(0, MAX_MOVE_TIME - timeSinceLastMove)
          }
        });
      }
    } catch (error) {
      this.logger.error({
        event: 'handleActiveGameError',
        error: error.message,
        stack: error.stack,
        gameId,
        clientId: client.id,
        timestamp: new Date().toISOString()
      });
      this.clientGames.delete(client.telegramId);
    }
  }

  async handleDisconnect(client: SocketWithAuth) {
    try {
      const telegramId = client.telegramId;
      this.connectedClients.delete(telegramId);

      // Обработка активного лобби
      const lobbyId = this.clientLobbies.get(telegramId);
      if (lobbyId) {
        await this.gameService.markLobbyPending(lobbyId);
        const timeout = setTimeout(async () => {
          const lobby = await this.gameService.getLobby(lobbyId);
          if (lobby && lobby.status === 'pending') {
            await this.gameService.deleteLobby(lobbyId);
            this.clientLobbies.delete(telegramId);
            this.server.to(lobbyId).emit('lobbyDeleted', {
              reason: 'Creator disconnected and did not reconnect'
            });
          }
        }, 30000);
        this.reconnectTimeouts.set(telegramId, timeout);
      }

      // Обработка активной игры
      const gameId = this.clientGames.get(telegramId);
      if (gameId) {
        const session = await this.gameService.getGameSession(gameId);
        if (session) {
          this.server.to(gameId).emit('playerDisconnected', { telegramId });
          const timeout = setTimeout(async () => {
            const winnerId = session.creatorId === telegramId ? session.opponentId : session.creatorId;
            await this.gameService.endGameSession(gameId, winnerId);
            this.server.to(gameId).emit('gameEnded', {
              winner: winnerId,
              reason: 'disconnect'
            });
            this.clientGames.delete(telegramId);
            this.reconnectTimeouts.delete(telegramId);
          }, 30000);
          this.reconnectTimeouts.set(telegramId, timeout);
        }
      }

      this.logger.log({
        event: 'clientDisconnected',
        clientId: client.id,
        telegramId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      this.logger.error({
        event: 'disconnectError',
        error: error.message,
        stack: error.stack,
        clientId: client.id,
        timestamp: new Date().toISOString()
      });
    }
  }

  @SubscribeMessage('createLobby')
  async handleCreateLobby(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: CreateLobbyDto
  ) {
    try {
      this.logger.log({
        event: 'createLobbyStarted',
        clientId: client.id,
        telegramId: client.telegramId,
        timestamp: new Date().toISOString()
      });

      const lobby = await this.gameService.createLobby(client.telegramId);
      if (!lobby) {
        throw new Error('Failed to create lobby');
      }

      this.clientLobbies.set(client.telegramId, lobby.id);
      client.join(lobby.id);

      this.server.to(lobby.id).emit('lobbyReady', { 
        lobbyId: lobby.id,
        timestamp: Date.now()
      });

      return { 
        status: 'created', 
        lobbyId: lobby.id,
        timestamp: Date.now()
      };
    } catch (error) {
      this.logger.error({
        event: 'createLobbyError',
        error: error.message,
        stack: error.stack,
        clientId: client.id,
        telegramId: client.telegramId,
        timestamp: new Date().toISOString()
      });

      this.clientLobbies.delete(client.telegramId);
      return { 
        status: 'error',
        message: error.message,
        timestamp: Date.now()
      };
    }
  }

  @SubscribeMessage('joinLobby')
  async handleJoinLobby(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: JoinLobbyDto
  ) {
    this.logger.log({
      event: 'joinLobbyStarted',
      clientId: client.id,
      telegramId: data.telegramId,
      lobbyId: data.lobbyId,
      timestamp: new Date().toISOString()
    });

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

      this.logger.log({
        event: 'lobbyJoined',
        clientId: client.id,
        telegramId: data.telegramId,
        lobbyId: data.lobbyId,
        timestamp: new Date().toISOString()
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
      
      this.logger.error({
        event: 'joinLobbyError',
        clientId: client.id,
        telegramId: data.telegramId,
        lobbyId: data.lobbyId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      
      return {
        status: 'error',
        errorType: 'join_failed',
        message: 'Failed to join the game. Please try again.'
      };
    }
  }

  @SubscribeMessage('makeMove')
  async handleMove(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: MakeMoveDto
  ) {
    const startTime = Date.now();
    const telegramId = client.telegramId;

    this.logger.log({
      event: 'makeMoveStarted',
      clientId: client.id,
      telegramId,
      gameId: data.gameId,
      position: data.position,
      player: data.player,
      moveTime: data.moveTime,
      timestamp: new Date().toISOString()
    });

    console.log('🎯 Handling move request', {
      gameId: data.gameId,
      telegramId,
      position: data.position,
      player: data.player,
      moveTime: data.moveTime,
      timestamp: new Date().toISOString()
    });

    try {
      const session = this.gameService.getGameSession(data.gameId);
      if (!session) {
        console.error('❌ Game session not found for move', {
          gameId: data.gameId,
          telegramId,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Проверяем, что это ход нужного игрока
      if (session.currentTurn !== telegramId) {
        console.warn('⚠️ Invalid turn attempt', {
          gameId: data.gameId,
          expectedPlayer: session.currentTurn,
          actualPlayer: telegramId,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Проверяем время хода
      const timeSinceLastMove = Date.now() - session.lastMoveTime;
      if (timeSinceLastMove > 30000) { // 30 секунд
        console.warn('⚠️ Move time expired', {
          gameId: data.gameId,
          telegramId,
          timeSinceLastMove,
          timestamp: new Date().toISOString()
        });
        
        // Определяем победителя (противник текущего игрока)
        const winner = session.currentTurn === session.creatorId ? session.opponentId : session.creatorId;
        await this.gameService.endGameSession(data.gameId, winner, 'timeout');
        
        this.server.to(data.gameId).emit('gameEnded', {
          winner,
          reason: 'timeout',
          statistics: {
            totalTime: Math.floor((Date.now() - session.startedAt) / 1000),
            moves: session.numMoves,
            playerTime1: session.playerTime1,
            playerTime2: session.playerTime2,
            lastMoveTime: timeSinceLastMove
          }
        });
        return;
      }

      // Обновляем состояние игры
      const nextTurn = session.currentTurn === session.creatorId ? session.opponentId : session.creatorId;
      const updatedSession = await this.gameService.updateGameSession(data.gameId, {
        currentTurn: nextTurn,
        lastMoveTime: Date.now(),
        numMoves: session.numMoves + 1,
        playerTime1: session.currentTurn === session.creatorId ? session.playerTime1 + data.moveTime : session.playerTime1,
        playerTime2: session.currentTurn === session.opponentId ? session.playerTime2 + data.moveTime : session.playerTime2
      });

      // Отправляем ход всем игрокам
      this.server.to(data.gameId).emit('moveMade', {
        position: data.position,
        player: data.player,
        gameState: {
          currentTurn: updatedSession.currentTurn,
          playerTime1: updatedSession.playerTime1,
          playerTime2: updatedSession.playerTime2,
          serverTime: Date.now(),
          moveStartTime: updatedSession.lastMoveTime,
          gameStartTime: updatedSession.startedAt
        },
        moveId: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      });

      console.log('✅ Move processed successfully', {
        gameId: data.gameId,
        telegramId,
        nextTurn,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });

      this.logger.log({
        event: 'moveCompleted',
        clientId: client.id,
        telegramId,
        gameId: data.gameId,
        position: data.position,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error processing move:', {
        gameId: data.gameId,
        telegramId,
        error: error.stack,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });

      this.logger.error({
        event: 'makeMoveError',
        clientId: client.id,
        telegramId,
        gameId: data.gameId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
    }
  }

  @SubscribeMessage('updatePlayerTime')
  @UsePipes(new ValidationPipe())
  async handleTimeUpdate(
    @ConnectedSocket() client: SocketWithAuth,
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
    @ConnectedSocket() client: SocketWithAuth,
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
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: JoinGameDto
  ) {
    this.clientGames.set(data.telegramId, data.gameId);
    client.join(data.gameId);
    
    return { status: 'joined' };
  }

  @SubscribeMessage('timeExpired')
  async handleTimeExpired(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: TimeExpiredDto
  ) {
    const startTime = Date.now();
    const telegramId = client.telegramId;

    console.log('⏰ Handling time expired event', {
      gameId: data.gameId,
      telegramId,
      player: data.player,
      timestamp: new Date().toISOString()
    });

    try {
      const session = this.gameService.getGameSession(data.gameId);
      if (!session) {
        console.error('❌ Game session not found for time expired event', {
          gameId: data.gameId,
          telegramId,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Проверяем, что время действительно истекло
      const timeSinceLastMove = Date.now() - session.lastMoveTime;
      if (timeSinceLastMove <= 30000) { // 30 секунд
        console.warn('⚠️ Invalid time expired event - time not actually expired', {
          gameId: data.gameId,
          telegramId,
          timeSinceLastMove,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Определяем победителя (противник текущего игрока)
      const winner = session.currentTurn === session.creatorId ? session.opponentId : session.creatorId;
      
      console.log('🏁 Ending game due to time expiration', {
        gameId: data.gameId,
        winner,
        loser: session.currentTurn,
        timeSinceLastMove,
        timestamp: new Date().toISOString()
      });

      await this.gameService.endGameSession(data.gameId, winner, 'timeout');
      
      this.server.to(data.gameId).emit('gameEnded', {
        winner,
        reason: 'timeout',
        statistics: {
          totalTime: Math.floor((Date.now() - session.startedAt) / 1000),
          moves: session.numMoves,
          playerTime1: session.playerTime1,
          playerTime2: session.playerTime2,
          lastMoveTime: timeSinceLastMove
        }
      });

      console.log('✅ Time expired event handled successfully', {
        gameId: data.gameId,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error handling time expired event:', {
        gameId: data.gameId,
        telegramId,
        error: error.stack,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });
    }
  }

  @SubscribeMessage('createInvite')
  @UsePipes(new ValidationPipe())
  async handleCreateInvite(
    @ConnectedSocket() client: SocketWithAuth,
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
        title: "Invitation to the game! ⚔️",
        description: "Click to accept the challenge!",
        input_message_content: {
          message_text: `❌ Invitation to the game ⭕️\n\nPlayer invites you\nto fight in endless TicTacToe!`,
          parse_mode: "HTML"
        },
        reply_markup: {
          inline_keyboard: [[{
            text: "⚔️ Accept the battle 🛡",
            url: `https://t.me/TacTicToe_bot?startapp=${lobby.id}`
          }]]
        },
        thumbnail_url: "https://igra.top/media/inviteImg.png",
        thumbnail_width: 300,
        thumbnail_height: 300
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

      // Добавляем обработку таймаутов и повторных попыток
      const maxRetries = 3;
      let retryCount = 0;
      let lastError = null;

      while (retryCount < maxRetries) {
        try {
          const { data: response } = await firstValueFrom(
            this.httpService.get(url, { 
              timeout: 5000,
              headers: {
                'User-Agent': 'TicTacToe-Bot/1.0'
              }
            })
          );
          
          console.log('📨 Telegram API response:', {
            response,
            attempt: retryCount + 1,
            timestamp: new Date().toISOString()
          });

          return { 
            messageId: response.result.id, 
            lobbyId: lobby.id 
          };
        } catch (error) {
          lastError = error;
          retryCount++;
          
          console.warn(`❌ Attempt ${retryCount}/${maxRetries} failed:`, {
            error: error.message,
            code: error.code,
            timestamp: new Date().toISOString()
          });

          if (retryCount < maxRetries) {
            // Экспоненциальная задержка перед следующей попыткой
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
          }
        }
      }

      console.error('❌ All retry attempts failed:', {
        error: lastError?.message,
        lobbyId: lobby.id,
        timestamp: new Date().toISOString()
      });
      return { error: 'Failed to create invite' };
    } catch (error) {
      console.error('❌ Error creating invite:', error);
      return { error: 'Failed to create invite' };
    }
  }

  @SubscribeMessage('cancelLobby')
  @UsePipes(new ValidationPipe())
  async handleCancelLobby(
    @ConnectedSocket() client: SocketWithAuth,
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

  @SubscribeMessage('updateViewport')
  async handleViewportUpdate(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: UpdateViewportDto
  ) {
    const telegramId = client.telegramId;

    console.log('🔄 Handling viewport update', {
      gameId: data.gameId,
      telegramId,
      viewport: data.viewport,
      timestamp: new Date().toISOString()
    });

    try {
      const session = this.gameService.getGameSession(data.gameId);
      if (!session) {
        console.warn('⚠️ Game session not found for viewport update', {
          gameId: data.gameId,
          telegramId,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Отправляем обновление всем игрокам, кроме отправителя
      client.to(data.gameId).emit('viewportUpdated', {
        telegramId,
        viewport: data.viewport
      });

      console.log('✅ Viewport update broadcasted', {
        gameId: data.gameId,
        telegramId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error updating viewport:', {
        gameId: data.gameId,
        telegramId,
        error: error.stack,
        timestamp: new Date().toISOString()
      });
    }
  }

  @SubscribeMessage('uiState')
  async handleUiState(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: { state: 'loader' | 'startScreen' | 'waitModal' | 'loss' | 'appClosed', telegramId: string, details?: any }
  ) {
    this.logger.log({
      event: 'uiStateUpdate',
      clientId: client.id,
      telegramId: data.telegramId,
      state: data.state,
      details: data.details,
      timestamp: new Date().toISOString()
    });
  }

  @SubscribeMessage('checkActiveLobby')
  async handleCheckActiveLobby(
    @ConnectedSocket() client: SocketWithAuth,
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

  @SubscribeMessage('updateLobbyStatus')
  @UsePipes(new ValidationPipe())
  async handleUpdateLobbyStatus(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: UpdateLobbyStatusDto
  ) {
    console.log('🔄 Handling lobby status update:', {
      telegramId: data.telegramId,
      lobbyId: data.lobbyId,
      newStatus: data.newStatus,
      socketId: client.id,
      timestamp: new Date().toISOString()
    });

    try {
      const updatedLobby = await this.gameService.updateLobbyStatus(
        data.lobbyId,
        data.newStatus,
        data.telegramId
      );

      // Оповещаем всех участников лобби
      this.server.to(data.lobbyId).emit('lobbyStatusUpdated', {
        lobbyId: data.lobbyId,
        status: data.newStatus,
        opponentId: data.opponentId,
        timestamp: Date.now()
      });

      console.log('✅ Lobby status update handled:', {
        lobbyId: data.lobbyId,
        newStatus: data.newStatus,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'updated',
        lobby: updatedLobby,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('❌ Error handling lobby status update:', {
        error: error.message,
        lobbyId: data.lobbyId,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'error',
        message: error.message,
        timestamp: Date.now()
      };
    }
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
