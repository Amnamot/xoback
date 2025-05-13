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
  cors: {
    origin: [process.env.SOCKET_URL || 'https://igra.top'],
    credentials: true
  }
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private connectedClients = new Map<string, Socket>();
  private clientGames = new Map<string, string>(); // telegramId -> gameId
  private reconnectTimeouts = new Map<string, NodeJS.Timeout>(); // telegramId -> timeout

  constructor(
    private readonly gameService: GameService,
    private readonly configService: ConfigService
  ) {
    console.log('WebSocket URL:', this.configService.get('SOCKET_URL'));
  }

  async handleConnection(client: Socket) {
    const telegramId = client.handshake.query.telegramId as string;
    if (!telegramId) {
      client.disconnect();
      return;
    }

    // Очищаем таймаут переподключения, если он был
    const existingTimeout = this.reconnectTimeouts.get(telegramId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.reconnectTimeouts.delete(telegramId);
    }

    this.connectedClients.set(telegramId, client);
    
    // Проверяем, есть ли активная игра
    const gameId = this.clientGames.get(telegramId);
    if (gameId) {
      const session = await this.gameService.getGameSession(gameId);
      if (session) {
        client.join(gameId);
        this.server.to(gameId).emit('playerReconnected', {
          telegramId,
          gameState: session
        });
      }
    }

    console.log(`Client connected: ${telegramId}`);
  }

  async handleDisconnect(client: Socket) {
    const telegramId = client.handshake.query.telegramId as string;
    if (!telegramId) return;

    this.connectedClients.delete(telegramId);
    
    // Проверяем, находится ли игрок в активной игре
    const gameId = this.clientGames.get(telegramId);
    if (gameId) {
      const session = await this.gameService.getGameSession(gameId);
      if (session) {
        // Уведомляем оппонента об отключении
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
    @MessageBody() data: { lobbyId: string, telegramId: string }
  ) {
    const { lobbyId, telegramId } = data;
    const lobby = await this.gameService.createLobby(telegramId);
    client.join(lobbyId);
    return { status: 'created', lobbyId: lobby.id };
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

    // Обновляем время игрока, который сделал ход
    const isCreator = player === session.creatorId;
    const updatedSession = await this.gameService.updateGameSession(gameId, {
      playerTime1: isCreator ? session.playerTime1 + moveTime : session.playerTime1,
      playerTime2: !isCreator ? session.playerTime2 + moveTime : session.playerTime2,
      lastMoveTime: Date.now(),
      currentTurn: isCreator ? session.opponentId : session.creatorId,
      numMoves: session.numMoves + 1
    });

    // Отправляем обновление всем игрокам
    this.server.to(gameId).emit('moveMade', {
      position,
      player,
      gameState: {
        playerTime1: updatedSession.playerTime1,
        playerTime2: updatedSession.playerTime2,
        currentTurn: updatedSession.currentTurn,
        numMoves: updatedSession.numMoves
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
}
