import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { GameSession, Lobby } from './types';

@Injectable()
export class GameService {
  private activeSessions = new Map<string, GameSession>();
  private activeLobbies = new Map<string, Lobby>();
  private userLobbyRequests = new Map<string, { count: number, timestamp: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private async checkLobbyLimit(telegramId: string): Promise<boolean> {
    // Проверяем существующие лобби пользователя
    for (const [_, lobby] of this.activeLobbies) {
      if (lobby.creatorId === telegramId && lobby.status === 'active') {
        return false;
      }
    }
    return true;
  }

  private async checkRateLimit(telegramId: string): Promise<boolean> {
    const now = Date.now();
    const userRequests = this.userLobbyRequests.get(telegramId);

    if (!userRequests) {
      // Первый запрос
      this.userLobbyRequests.set(telegramId, { count: 1, timestamp: now });
      return true;
    }

    if (now - userRequests.timestamp > 60000) {
      // Прошла минута, сбрасываем счетчик
      this.userLobbyRequests.set(telegramId, { count: 1, timestamp: now });
      return true;
    }

    if (userRequests.count >= 1) {
      // Превышен лимит запросов в минуту
      return false;
    }

    // Увеличиваем счетчик
    userRequests.count++;
    this.userLobbyRequests.set(telegramId, userRequests);
    return true;
  }

  // Методы для работы с лобби
  getActiveLobbies(): Map<string, Lobby> {
    return this.activeLobbies;
  }

  async checkLobbyInRedis(lobbyId: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(lobbyId);
      return exists === 1;
    } catch (error) {
      console.error('Redis error:', error);
      return false;
    }
  }

  async createLobby(creatorId: string): Promise<Lobby | null> {
    try {
      // Проверяем лимит на количество лобби
      const canCreateLobby = await this.checkLobbyLimit(creatorId);
      if (!canCreateLobby) {
        throw new Error('You already have an active lobby');
      }

      // Проверяем rate limit
      const withinRateLimit = await this.checkRateLimit(creatorId);
      if (!withinRateLimit) {
        throw new Error('Please wait before creating another lobby');
      }

      const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const lobby: Lobby = {
        id: lobbyId,
        creatorId,
        createdAt: Date.now(),
        status: 'active'
      };

      // Сохраняем в Redis с TTL
      await this.redis.set(lobbyId, JSON.stringify(lobby), 'EX', 180);
      this.activeLobbies.set(lobbyId, lobby);

      return lobby;
    } catch (error) {
      console.error('Error creating lobby:', error);
      throw error;
    }
  }

  async getLobby(lobbyId: string): Promise<Lobby | null> {
    try {
      const lobby = this.activeLobbies.get(lobbyId);
      if (!lobby) {
        // Пробуем получить из Redis
        const redisLobby = await this.redis.get(lobbyId);
        if (redisLobby) {
          const lobby = JSON.parse(redisLobby) as Lobby;
          this.activeLobbies.set(lobbyId, lobby);
          return lobby;
        }
        return null;
      }
      return lobby;
    } catch (error) {
      console.error('Error getting lobby:', error);
      return null;
    }
  }

  async markLobbyPending(lobbyId: string): Promise<void> {
    try {
      const lobby = this.activeLobbies.get(lobbyId);
      if (lobby) {
        lobby.status = 'pending';
        this.activeLobbies.set(lobbyId, lobby);
        // Обновляем в Redis с TTL 10 секунд
        await this.redis.set(lobbyId, JSON.stringify(lobby), 'EX', 10);
      }
    } catch (error) {
      console.error('Error marking lobby as pending:', error);
    }
  }

  async restoreLobby(lobbyId: string): Promise<void> {
    try {
      const lobby = this.activeLobbies.get(lobbyId);
      if (lobby) {
        lobby.status = 'active';
        this.activeLobbies.set(lobbyId, lobby);
        // Восстанавливаем TTL в Redis до исходного значения
        await this.redis.set(lobbyId, JSON.stringify(lobby), 'EX', 180);
      }
    } catch (error) {
      console.error('Error restoring lobby:', error);
    }
  }

  async deleteLobby(lobbyId: string): Promise<void> {
    try {
      const lobby = this.activeLobbies.get(lobbyId);
      if (lobby) {
        lobby.status = 'closed';
        this.activeLobbies.delete(lobbyId);
        await this.redis.del(lobbyId);
      }
    } catch (error) {
      console.error('Error deleting lobby:', error);
    }
  }

  // Методы для работы с игровыми сессиями
  async createGameSession(lobbyId: string, opponentId: string, pay: boolean = false): Promise<GameSession> {
    const lobby = this.activeLobbies.get(lobbyId);
    if (!lobby) {
      throw new Error('Lobby not found');
    }

    const session: GameSession = {
      id: lobbyId, // используем тот же ID
      creatorId: lobby.creatorId,
      opponentId,
      currentTurn: lobby.creatorId, // первый ход за создателем
      board: Array(100).fill(null).map(() => Array(100).fill(null)), // 100x100 пустая доска
      numMoves: 0,
      pay,
      startedAt: Date.now(),
      playerTime1: 0,
      playerTime2: 0,
      lastMoveTime: Date.now()
    };

    this.activeSessions.set(session.id, session);
    
    // Удаляем лобби
    await this.deleteLobby(lobbyId);

    return session;
  }

  getGameSession(gameId: string): GameSession | null {
    return this.activeSessions.get(gameId) || null;
  }

  async updateGameSession(gameId: string, updates: Partial<GameSession>): Promise<GameSession> {
    const session = this.activeSessions.get(gameId);
    if (!session) {
      throw new Error('Game session not found');
    }

    Object.assign(session, updates);
    this.activeSessions.set(gameId, session);
    return session;
  }

  async getGameResult(gameId: string): Promise<{ 
    winner: string;
    reason: string;
    statistics: {
      totalTime: number;
      moves: number;
      playerTime1: number;
      playerTime2: number;
    };
  } | null> {
    try {
      // Проверяем в БД
      const game = await this.prisma.game.findFirst({
        where: {
          id: parseInt(gameId)
        }
      });

      if (!game) return null;

      return {
        winner: game.winner,
        reason: game.reason || 'unknown',
        statistics: {
          totalTime: game.time,
          moves: game.numMoves,
          playerTime1: game.playertime1,
          playerTime2: game.playertime2
        }
      };
    } catch (error) {
      console.error('Error getting game result:', error);
      return null;
    }
  }

  async endGameSession(gameId: string, winnerId: string, reason: string = 'unknown'): Promise<void> {
    const session = this.activeSessions.get(gameId);
    if (!session) {
      throw new Error('Game session not found');
    }

    // Создаем запись в БД
    const game = await this.prisma.game.create({
      data: {
        createdBy: session.creatorId,
        rival: session.opponentId,
        winner: winnerId,
        reason: reason,
        pay: session.pay,
        numMoves: session.numMoves,
        time: Math.floor((Date.now() - session.startedAt) / 1000),
        playertime1: Math.floor(session.playerTime1 / 1000),
        playertime2: Math.floor(session.playerTime2 / 1000),
        created: new Date(session.startedAt),
        finished: new Date()
      }
    });

    // Удаляем сессию
    this.activeSessions.delete(gameId);
  }
} 