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
  ) {
    console.log('🎮 Game service initialized', {
      timestamp: new Date().toISOString(),
      activeSessions: this.activeSessions.size,
      activeLobbies: this.activeLobbies.size
    });

    // Запускаем периодическую очистку каждые 5 минут
    setInterval(() => {
      console.log('🧹 Starting periodic cleanup', {
        timestamp: new Date().toISOString(),
        activeSessions: this.activeSessions.size,
        activeLobbies: this.activeLobbies.size,
        userLobbyRequests: this.userLobbyRequests.size
      });

      this.cleanupInconsistentData().catch(error => {
        console.error('❌ Error during cleanup:', {
          error: error.stack,
          timestamp: new Date().toISOString()
        });
      });
    }, 5 * 60 * 1000);
  }

  private async checkLobbyLimit(telegramId: string): Promise<boolean> {
    console.log('🔍 Checking lobby limit', {
      telegramId,
      timestamp: new Date().toISOString(),
      activeLobbies: this.activeLobbies.size
    });

    // Проверяем существующие лобби пользователя в памяти
    for (const [_, lobby] of this.activeLobbies) {
      if (lobby.creatorId === telegramId && lobby.status === 'active') {
        console.warn('⚠️ User already has active lobby in memory', {
          telegramId,
          lobbyId: lobby.id,
          timestamp: new Date().toISOString()
        });
        return false;
      }
    }

    // Проверяем существующие лобби в Redis через индекс
    const existingLobbyId = await this.redis.get(`user_lobby:${telegramId}`);
    
    if (existingLobbyId) {
      console.log('🔍 Found existing lobby in Redis', {
        telegramId,
        lobbyId: existingLobbyId,
        timestamp: new Date().toISOString()
      });

      const lobbyData = await this.redis.get(existingLobbyId);
      if (lobbyData) {
        const lobby = JSON.parse(lobbyData);
        this.activeLobbies.set(existingLobbyId, {
          id: existingLobbyId,
          creatorId: telegramId,
          createdAt: Date.now(),
          status: 'active'
        });
        console.log('📝 Restored lobby from Redis to memory', {
          telegramId,
          lobbyId: existingLobbyId,
          lobbyData: lobby,
          timestamp: new Date().toISOString()
        });
        return false;
      }
      // Если лобби не найдено, но индекс есть - очищаем индекс
      console.warn('⚠️ Lobby index exists but lobby not found, cleaning up', {
        telegramId,
        lobbyId: existingLobbyId,
        timestamp: new Date().toISOString()
      });
      await this.redis.del(`user_lobby:${telegramId}`);
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
    console.log('🎯 Starting lobby creation for creator:', creatorId);
    
    try {
      // Проверяем rate limit
      const withinRateLimit = await this.checkRateLimit(creatorId);
      if (!withinRateLimit) {
        console.warn('⚠️ Rate limit exceeded for creator:', creatorId);
        throw new Error('Please wait before creating another lobby');
      }

      // Пытаемся атомарно создать блокировку
      console.log('🔒 Attempting to acquire lock for creator:', creatorId);
      const lockResult = await this.redis.set(
        `user_lobby:${creatorId}`,
        'pending',
        'EX',
        180,
        'NX'
      );

      if (!lockResult) {
        console.warn('⚠️ Creator already has an active lobby:', creatorId);
        
        // Проверяем существующее лобби
        const existingLobbyId = await this.redis.get(`user_lobby:${creatorId}`);
        console.log('🔍 Found existing lobby:', existingLobbyId);
        
        if (existingLobbyId && existingLobbyId !== 'pending') {
          const lobbyData = await this.redis.get(existingLobbyId);
          if (lobbyData) {
            console.warn('⚠️ Active lobby exists:', { lobbyId: existingLobbyId, data: lobbyData });
          }
        }
        
        throw new Error('You already have an active lobby');
      }

      console.log('✅ Lock acquired for creator:', creatorId);

      try {
        const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        console.log('📝 Generating new lobby:', lobbyId);

        const lobby: Lobby = {
          id: lobbyId,
          creatorId,
          createdAt: Date.now(),
          status: 'active'
        };

        // Создаем лобби атомарно
        const multi = this.redis.multi();
        multi.set(lobbyId, JSON.stringify(lobby), 'EX', 180);
        multi.set(`user_lobby:${creatorId}`, lobbyId, 'EX', 180);
        
        console.log('💾 Executing Redis transaction for lobby creation');
        const results = await multi.exec();
        
        if (!results || results.some(result => !result[1])) {
          console.error('❌ Redis transaction failed:', results);
          throw new Error('Failed to create lobby: Redis transaction error');
        }

        console.log('✅ Lobby successfully created in Redis:', { lobbyId, creatorId });
        
        // Сохраняем в памяти
        this.activeLobbies.set(lobbyId, lobby);
        console.log('📦 Lobby saved in memory');

        // Верификация
        const [storedLobby, storedIndex] = await Promise.all([
          this.redis.get(lobbyId),
          this.redis.get(`user_lobby:${creatorId}`)
        ]);
        
        console.log('🔍 Verification:', {
          lobbyExists: !!storedLobby,
          indexExists: !!storedIndex,
          indexMatches: storedIndex === lobbyId
        });

        return lobby;
      } catch (error) {
        // При ошибке удаляем временную блокировку
        console.error('❌ Error during lobby creation:', error);
        await this.redis.del(`user_lobby:${creatorId}`);
        console.log('🧹 Cleaned up temporary lock for creator:', creatorId);
        throw error;
      }
    } catch (error) {
      console.error('❌ Lobby creation failed:', error);
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
    console.log('⏳ Marking lobby as pending:', lobbyId);
    
    try {
      const lobby = this.activeLobbies.get(lobbyId);
      if (lobby) {
        console.log('📝 Found lobby in memory:', { lobbyId, creatorId: lobby.creatorId });
        
        lobby.status = 'pending';
        
        const multi = this.redis.multi();
        // Основной TTL лобби остается 180 секунд
        multi.set(lobbyId, JSON.stringify(lobby), 'EX', 180);
        multi.set(`user_lobby:${lobby.creatorId}`, lobbyId, 'EX', 180);
        // Добавляем отдельный ключ для pending статуса с TTL 30 секунд
        multi.set(`pending:${lobbyId}`, '1', 'EX', 30);
        
        console.log('💾 Executing Redis transaction for pending status');
        const results = await multi.exec();
        
        if (!results || results.some(result => !result[1])) {
          console.error('❌ Redis transaction failed:', results);
          throw new Error('Failed to mark lobby as pending');
        }
        
        console.log('✅ Lobby marked as pending:', lobbyId);
      }
    } catch (error) {
      console.error('❌ Error marking lobby as pending:', error);
      throw error;
    }
  }

  async restoreLobby(lobbyId: string): Promise<void> {
    try {
      const lobby = this.activeLobbies.get(lobbyId);
      if (lobby) {
        lobby.status = 'active';
        
        const multi = this.redis.multi();
        // Восстанавливаем TTL в Redis до исходного значения
        multi.set(lobbyId, JSON.stringify(lobby), 'EX', 180);
        // Восстанавливаем TTL индекса
        multi.set(`user_lobby:${lobby.creatorId}`, lobbyId, 'EX', 180);
        await multi.exec();
        
        this.activeLobbies.set(lobbyId, lobby);
      }
    } catch (error) {
      console.error('Error restoring lobby:', error);
    }
  }

  async deleteLobby(lobbyId: string): Promise<void> {
    console.log('🗑️ Starting lobby deletion:', lobbyId);
    
    try {
      const lobby = this.activeLobbies.get(lobbyId);
      if (lobby) {
        console.log('📝 Found lobby in memory:', { lobbyId, creatorId: lobby.creatorId });
        
        const multi = this.redis.multi();
        multi.del(lobbyId);
        multi.del(`user_lobby:${lobby.creatorId}`);
        
        console.log('💾 Executing Redis transaction for lobby deletion');
        const results = await multi.exec();
        
        if (!results || results.some(result => !result[1])) {
          console.warn('⚠️ Redis deletion partially failed:', results);
        }

        lobby.status = 'closed';
        this.activeLobbies.delete(lobbyId);
        
        // Очищаем rate limit данные для создателя лобби
        this.userLobbyRequests.delete(lobby.creatorId);
        console.log('🧹 Cleaned up rate limit data for creator:', lobby.creatorId);
        
        console.log('✅ Lobby successfully deleted:', lobbyId);
      } else {
        console.warn('⚠️ Lobby not found in memory:', lobbyId);
      }
    } catch (error) {
      console.error('❌ Error during lobby deletion:', error);
      throw error;
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
    console.log('🔄 Updating game session', {
      gameId,
      updates,
      timestamp: new Date().toISOString()
    });

    const session = this.activeSessions.get(gameId);
    if (!session) {
      console.error('❌ Game session not found for update', {
        gameId,
        timestamp: new Date().toISOString()
      });
      throw new Error('Game session not found');
    }

    const updatedSession = { ...session, ...updates };
    this.activeSessions.set(gameId, updatedSession);

    console.log('✅ Game session updated', {
      gameId,
      session: {
        creatorId: updatedSession.creatorId,
        opponentId: updatedSession.opponentId,
        currentTurn: updatedSession.currentTurn,
        numMoves: updatedSession.numMoves,
        lastMoveTime: new Date(updatedSession.lastMoveTime).toISOString()
      },
      timestamp: new Date().toISOString()
    });

    return updatedSession;
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
    console.log('🏁 Ending game session', {
      gameId,
      winnerId,
      reason,
      timestamp: new Date().toISOString()
    });

    const session = this.activeSessions.get(gameId);
    if (!session) {
      console.error('❌ Game session not found for ending', {
        gameId,
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      // Сохраняем результат в БД
      const gameResult = await this.prisma.game.create({
        data: {
          createdBy: session.creatorId,
          rival: session.opponentId,
          winner: winnerId,
          reason: reason,
          pay: session.pay || false,
          numMoves: session.numMoves,
          time: Math.floor((Date.now() - session.startedAt) / 1000),
          playertime1: Math.floor(session.playerTime1 / 1000),
          playertime2: Math.floor(session.playerTime2 / 1000),
          created: new Date(session.startedAt),
          finished: new Date()
        }
      });

      console.log('💾 Game result saved to database', {
        gameId,
        result: {
          winner: gameResult.winner,
          reason: gameResult.reason,
          time: gameResult.time,
          numMoves: gameResult.numMoves
        },
        timestamp: new Date().toISOString()
      });

      // Очищаем сессию из памяти
      this.activeSessions.delete(gameId);
      
      console.log('🧹 Game session cleaned up', {
        gameId,
        activeSessions: this.activeSessions.size,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error ending game session:', {
        gameId,
        error: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  // Добавляем метод для периодической проверки консистентности данных
  private async cleanupInconsistentData(): Promise<void> {
    const startTime = Date.now();
    console.log('🧹 Starting inconsistent data cleanup', {
      timestamp: new Date().toISOString(),
      activeSessions: this.activeSessions.size,
      activeLobbies: this.activeLobbies.size
    });

    try {
      // Очищаем старые rate limit записи
      const now = Date.now();
      for (const [telegramId, data] of this.userLobbyRequests) {
        if (now - data.timestamp > 60000) {
          this.userLobbyRequests.delete(telegramId);
        }
      }

      // Проверяем все активные лобби
      for (const [lobbyId, lobby] of this.activeLobbies) {
        const exists = await this.redis.exists(lobbyId);
        if (!exists) {
          this.activeLobbies.delete(lobbyId);
          console.log('🗑️ Removed inconsistent lobby', {
            lobbyId,
            creatorId: lobby.creatorId,
            timestamp: new Date().toISOString()
          });
        }
      }

      // Проверяем все активные сессии
      for (const [gameId, session] of this.activeSessions) {
        const timeSinceLastMove = Date.now() - session.lastMoveTime;
        if (timeSinceLastMove > 24 * 60 * 60 * 1000) { // 24 часа
          this.activeSessions.delete(gameId);
          console.log('🗑️ Removed stale game session', {
            gameId,
            timeSinceLastMove: Math.floor(timeSinceLastMove / 1000),
            timestamp: new Date().toISOString()
          });
        }
      }

      console.log('✅ Cleanup completed', {
        duration: Date.now() - startTime,
        remainingSessions: this.activeSessions.size,
        remainingLobbies: this.activeLobbies.size,
        remainingRateLimits: this.userLobbyRequests.size,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error during cleanup:', {
        error: error.stack,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });
    }
  }

  async findLobbyByCreator(creatorId: string): Promise<Lobby | null> {
    try {
      // Сначала ищем в памяти
      for (const [_, lobby] of this.activeLobbies) {
        if (lobby.creatorId === creatorId) {
          return lobby;
        }
      }

      // Если не нашли в памяти, ищем через индекс в Redis
      const lobbyId = await this.redis.get(`user_lobby:${creatorId}`);
      if (!lobbyId) return null;

      // Получаем данные лобби
      const lobbyData = await this.redis.get(lobbyId);
      if (!lobbyData) {
        // Очищаем неактуальный индекс
        await this.redis.del(`user_lobby:${creatorId}`);
        return null;
      }

      try {
        const lobby = JSON.parse(lobbyData) as Lobby;
        // Проверяем TTL
        const ttl = await this.redis.ttl(lobbyId);
        
        // Если TTL истек или близок к истечению, считаем лобби недействительным
        if (ttl <= 0) {
          await this.deleteLobby(lobbyId);
          return null;
        }

        // Сохраняем в память и возвращаем
        this.activeLobbies.set(lobby.id, lobby);
        return lobby;
      } catch (error) {
        console.error('❌ Error parsing lobby data:', error);
        return null;
      }
    } catch (error) {
      console.error('Error finding lobby by creator:', error);
      return null;
    }
  }
} 