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
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameService } from './game.service';

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
    private readonly configService: ConfigService
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

    // Проверяем существующее подключение
    const existingSocket = this.connectedClients.get(telegramId);
    if (existingSocket && existingSocket.connected) {
      // Отключаем предыдущее соединение
      existingSocket.emit('multipleConnections', { message: 'New connection detected' });
      existingSocket.disconnect();
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

    console.log(`Client connected: ${telegramId}`);
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
      }, 10000); // 10 секунд на переподключение

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

    console.log(`Client disconnected: ${telegramId}`);
  }

  @SubscribeMessage('createLobby')
  async handleCreateLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { telegramId: string }
  ) {
    try {
      const { telegramId } = data;
      const lobby = await this.gameService.createLobby(telegramId);
      
      if (!lobby) {
        return { status: 'error', message: 'Failed to create lobby' };
      }

      // Сохраняем связь клиент-лобби
      this.clientLobbies.set(telegramId, lobby.id);
      
      // Добавляем клиента в комнату лобби
      client.join(lobby.id);
      
      return { status: 'created', lobbyId: lobby.id };
    } catch (error) {
      console.error('Error in handleCreateLobby:', error);
      return { 
        status: 'error', 
        message: error instanceof Error ? error.message : 'Failed to create lobby'
      };
    }
  }

  @SubscribeMessage('joinLobby')
  async handleJoinLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lobbyId: string, telegramId: string }
  ) {
    const { lobbyId, telegramId } = data;
    const lobby = await this.gameService.getLobby(lobbyId);

    if (!lobby) {
      return { status: 'error', message: 'Lobby not found' };
    }

    if (lobby.status !== 'active') {
      return { status: 'error', message: 'Lobby is not active' };
    }

    if (lobby.creatorId === telegramId) {
      client.join(lobbyId);
      return { status: 'creator' };
    }

    // Создаем игровую сессию
    const session = await this.gameService.createGameSession(lobbyId, telegramId);
    client.join(lobbyId);
    
    // Сохраняем связь игроков с игрой
    this.clientGames.set(lobby.creatorId, lobbyId);
    this.clientGames.set(telegramId, lobbyId);
    
    // Очищаем связь с лобби
    this.clientLobbies.delete(lobby.creatorId);
    
    // Уведомляем обоих игроков о начале игры
    this.server.to(lobbyId).emit('gameStart', {
      creator: lobby.creatorId,
      opponent: telegramId,
      session
    });

    return { status: 'joined' };
  }

  @SubscribeMessage('makeMove')
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string, position: { row: number, col: number }, player: string, moveTime: number }
  ) {
    const { gameId, position, player, moveTime } = data;
    const session = await this.gameService.getGameSession(gameId);
    
    if (!session) {
      return { status: 'error', message: 'Game session not found' };
    }

    const currentTime = Date.now();
    const timeSinceLastMove = currentTime - session.lastMoveTime;
    const MAX_MOVE_TIME = 30000; // 30 секунд на ход

    // Проверяем, не истекло ли время хода
    if (timeSinceLastMove > MAX_MOVE_TIME) {
      // Определяем победителя (тот, кто не должен был ходить)
      const winner = session.currentTurn === session.creatorId ? session.opponentId : session.creatorId;
      
      // Завершаем игру
      await this.gameService.endGameSession(gameId, winner);
      
      // Уведомляем всех игроков
      this.server.to(gameId).emit('gameEnded', {
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

      // Очищаем связи с игрой
      this.clientGames.delete(session.creatorId);
      this.clientGames.delete(session.opponentId);

      return { status: 'error', message: 'Move time expired' };
    }

    const isCreator = player === session.creatorId;

    // Проверяем, чей сейчас ход
    if (player !== session.currentTurn) {
      return { status: 'error', message: 'Not your turn' };
    }

    // Обновляем время игрока, который сделал ход
    const updatedSession = await this.gameService.updateGameSession(gameId, {
      playerTime1: isCreator ? session.playerTime1 + moveTime : session.playerTime1,
      playerTime2: !isCreator ? session.playerTime2 + moveTime : session.playerTime2,
      lastMoveTime: currentTime,
      currentTurn: isCreator ? session.opponentId : session.creatorId,
      numMoves: session.numMoves + 1
    });

    // Отправляем обновление всем игрокам с серверным временем
    this.server.to(gameId).emit('moveMade', {
      moveId: `move_${currentTime}`,
      position,
      player,
      gameState: {
        currentTurn: updatedSession.currentTurn,
        playerTime1: updatedSession.playerTime1,
        playerTime2: updatedSession.playerTime2,
        numMoves: updatedSession.numMoves,
        serverTime: currentTime,
        moveStartTime: currentTime,
        gameStartTime: session.startedAt,
        timeLeft: MAX_MOVE_TIME // сбрасываем таймер хода
      }
    });

    return { status: 'success' };
  }

  @SubscribeMessage('updatePlayerTime')
  async handleTimeUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string, playerTimes: { playerTime1: number, playerTime2: number } }
  ) {
    const { gameId, playerTimes } = data;
    const session = await this.gameService.getGameSession(gameId);
    
    if (!session) {
      return { status: 'error', message: 'Game session not found' };
    }

    // Обновляем время обоих игроков
    const updatedSession = await this.gameService.updateGameSession(gameId, {
      playerTime1: playerTimes.playerTime1,
      playerTime2: playerTimes.playerTime2
    });

    // Отправляем обновление времени всем игрокам
    this.server.to(gameId).emit('timeUpdated', {
      playerTime1: updatedSession.playerTime1,
      playerTime2: updatedSession.playerTime2
    });

    return { status: 'success' };
  }

  @SubscribeMessage('gameOver')
  async handleGameOver(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string, winner: string }
  ) {
    const { gameId, winner } = data;
    await this.gameService.endGameSession(gameId, winner);
    this.server.to(gameId).emit('gameEnded', { winner });
    
    // Очищаем связи игроков с игрой
    const session = await this.gameService.getGameSession(gameId);
    if (session) {
      this.clientGames.delete(session.creatorId);
      this.clientGames.delete(session.opponentId);
    }
  }

  @SubscribeMessage('joinGame')
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string, telegramId: string }
  ) {
    const { gameId, telegramId } = data;
    
    // Сохраняем связь игрока с игрой
    this.clientGames.set(telegramId, gameId);
    client.join(gameId);
    
    return { status: 'joined' };
  }

  @SubscribeMessage('timeExpired')
  async handleTimeExpired(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string, player: string }
  ) {
    const { gameId, player } = data;
    const session = await this.gameService.getGameSession(gameId);
    
    if (!session) {
      return { status: 'error', message: 'Game session not found' };
    }

    // Определяем победителя (противник того, у кого закончилось время)
    const winner = player === session.creatorId ? session.opponentId : session.creatorId;

    // Завершаем игру
    await this.gameService.endGameSession(gameId, winner);

    // Уведомляем всех игроков о завершении игры
    this.server.to(gameId).emit('gameEnded', {
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

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
