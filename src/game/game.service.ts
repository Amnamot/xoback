import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { GameSession, Lobby } from './types';

@Injectable()
export class GameService {
  private activeSessions = new Map<string, GameSession>();
  private activeLobbies = new Map<string, Lobby>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // Методы для работы с лобби
  async createLobby(creatorId: string): Promise<Lobby> {
    const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const lobby: Lobby = {
      id: lobbyId,
      creatorId,
      createdAt: Date.now(),
    };

    // Сохраняем в Redis с TTL
    await this.redis.set(lobbyId, creatorId, 'EX', 180);
    this.activeLobbies.set(lobbyId, lobby);

    return lobby;
  }

  async getLobby(lobbyId: string): Promise<Lobby | null> {
    return this.activeLobbies.get(lobbyId) || null;
  }

  async deleteLobby(lobbyId: string): Promise<void> {
    this.activeLobbies.delete(lobbyId);
    await this.redis.del(lobbyId);
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

    // Создаем запись в БД
    const game = await this.prisma.game.create({
      data: {
        createdBy: session.creatorId,
        rival: session.opponentId,
        pay: session.pay,
        numMoves: 0,
        time: 0,
        playertime1: 0,
        playertime2: 0,
        created: new Date(session.startedAt),
        finished: new Date(session.startedAt), // обновим при завершении
      }
    });

    session.dbId = game.id;
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

  async endGameSession(gameId: string, winnerId: string): Promise<void> {
    const session = this.activeSessions.get(gameId);
    if (!session) {
      throw new Error('Game session not found');
    }

    // Обновляем запись в БД
    await this.prisma.game.update({
      where: { id: session.dbId },
      data: {
        finished: new Date(),
        winner: winnerId,
        numMoves: session.numMoves,
        time: Math.floor((Date.now() - session.startedAt) / 1000),
        playertime1: Math.floor(session.playerTime1 / 1000),
        playertime2: Math.floor(session.playerTime2 / 1000),
      }
    });

    // Удаляем сессию
    this.activeSessions.delete(gameId);
  }
} 