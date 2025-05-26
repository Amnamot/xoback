// src/game/game.service.ts v1.0.3
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { GameSession, Lobby } from './types';

const MAX_MOVE_TIME = 30000; // 30 секунд на ход

interface GameState {
  board: any[];
  currentPlayer: string;
  scale: number;
  position: { x: number; y: number };
  time: number;
  playerTime1: number;
  playerTime2: number;
  startedAt: number;
  lastMoveTime: number;
  maxMoveTime: number;
  gameSession: {
    id: string;
    creatorId: string;
    opponentId: string;
    lobbyId: string;
  };
}

@Injectable()
export class GameService {
  private activeSessions = new Map<string, GameSession>();
  private activeLobbies = new Map<string, Lobby>();
  private userLobbyRequests = new Map<string, { count: number, timestamp: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis
  ) {
    // Запускаем периодическую очистку каждые 5 минут
    setInterval(() => this.cleanupStaleData(), 5 * 60 * 1000);
  }

  private async checkLobbyLimit(telegramId: string): Promise<boolean> {
    // Проверяем существующие лобби пользователя в памяти
    for (const [_, lobby] of this.activeLobbies) {
      if (String(lobby.creatorId) === String(telegramId) && lobby.status === 'active') {
        return false;
      }
    }

    // Проверяем существующие лобби в Redis через индекс
    const existingLobbyId = await this.redis.get(`user_lobby:${telegramId}`);
    
    if (existingLobbyId) {
      const lobbyData = await this.redis.get(existingLobbyId);
      if (lobbyData) {
        this.activeLobbies.set(existingLobbyId, {
          id: existingLobbyId,
          creatorId: telegramId,
          createdAt: Date.now(),
          status: 'active'
        });
        return false;
      }
      // Если лобби не найдено, но индекс есть - очищаем индекс
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
    console.log('🎯 [CreateLobby] Starting lobby creation for creator:', {
      creatorId,
      timestamp: new Date().toISOString()
    });
    
    try {
      // Проверяем rate limit
      const withinRateLimit = await this.checkRateLimit(creatorId);
      if (!withinRateLimit) {
        console.warn('⚠️ [CreateLobby] Rate limit exceeded for creator:', {
          creatorId,
          timestamp: new Date().toISOString()
        });
        throw new Error('Please wait before creating another lobby');
      }

      // Очищаем старые данные создателя
      const oldLobbyId = await this.redis.get(`user_lobby:${creatorId}`);
      if (oldLobbyId) {
        console.log('🧹 [CreateLobby] Cleaning up old lobby data:', {
          creatorId,
          oldLobbyId,
          timestamp: new Date().toISOString()
        });
        await this.redis.del(oldLobbyId);
        await this.redis.del(`user_lobby:${creatorId}`);
        this.activeLobbies.delete(oldLobbyId);
      }

      // Пытаемся атомарно создать блокировку
      console.log('🔒 [CreateLobby] Attempting to acquire lock for creator:', {
        creatorId,
        timestamp: new Date().toISOString()
      });

      const lockResult = await this.redis.set(
        `user_lobby:${creatorId}`,
        'pending',
        'EX',
        180,
        'NX'
      );

      if (!lockResult) {
        console.warn('⚠️ [CreateLobby] Creator already has an active lobby:', {
          creatorId,
          timestamp: new Date().toISOString()
        });
        
        // Проверяем существующее лобби
        const existingLobbyId = await this.redis.get(`user_lobby:${creatorId}`);
        console.log('🔍 [CreateLobby] Found existing lobby:', {
          existingLobbyId,
          timestamp: new Date().toISOString()
        });
        
        if (existingLobbyId && existingLobbyId !== 'pending') {
          const lobbyData = await this.redis.get(existingLobbyId);
          if (lobbyData) {
            console.warn('⚠️ [CreateLobby] Active lobby exists:', {
              lobbyId: existingLobbyId,
              data: lobbyData,
              timestamp: new Date().toISOString()
            });
          }
        }
        
        throw new Error('You already have an active lobby');
      }

      console.log('✅ [CreateLobby] Lock acquired for creator:', {
        creatorId,
        timestamp: new Date().toISOString()
      });

      try {
        const lobbyId = `lobby_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        console.log('📝 [CreateLobby] Generating new lobby:', {
          lobbyId,
          timestamp: new Date().toISOString()
        });

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
        
        console.log('💾 [CreateLobby] Executing Redis transaction for lobby creation');
        const results = await multi.exec();
        
        if (!results || results.some(result => !result[1])) {
          console.error('❌ [CreateLobby] Redis transaction failed:', {
            results,
            timestamp: new Date().toISOString()
          });
          throw new Error('Failed to create lobby: Redis transaction error');
        }

        console.log('✅ [CreateLobby] Lobby successfully created in Redis:', {
          lobbyId,
          creatorId,
          timestamp: new Date().toISOString()
        });
        
        // Сохраняем в памяти
        this.activeLobbies.set(lobbyId, lobby);
        console.log('📦 [CreateLobby] Lobby saved in memory');

        // Верификация
        const [storedLobby, storedIndex] = await Promise.all([
          this.redis.get(lobbyId),
          this.redis.get(`user_lobby:${creatorId}`)
        ]);
        
        console.log('🔍 [CreateLobby] Verification:', {
          lobbyExists: !!storedLobby,
          indexExists: !!storedIndex,
          indexMatches: storedIndex === lobbyId,
          ttl: await this.redis.ttl(lobbyId),
          timestamp: new Date().toISOString()
        });

        return lobby;
      } catch (error) {
        // При ошибке удаляем временную блокировку
        console.error('❌ [CreateLobby] Error during lobby creation:', {
          error: error instanceof Error ? error.message : 'Unknown error',
          creatorId,
          timestamp: new Date().toISOString()
        });
        await this.redis.del(`user_lobby:${creatorId}`);
        console.log('🧹 [CreateLobby] Cleaned up temporary lock for creator:', {
          creatorId,
          timestamp: new Date().toISOString()
        });
        throw error;
      }
    } catch (error) {
      console.error('❌ [CreateLobby] Lobby creation failed:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        creatorId,
        timestamp: new Date().toISOString()
      });
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
  async createGameSession(lobbyId: string, data: {
    creatorId: string;
    opponentId: string;
    creatorMarker: 'o' | 'x';
    opponentMarker: 'o' | 'x';
    startTime: number;
  }): Promise<GameSession> {
    console.log('🎮 [CreateGameSession] Starting game session creation:', {
      lobbyId,
      creatorId: data.creatorId,
      opponentId: data.opponentId,
      creatorMarker: data.creatorMarker,
      opponentMarker: data.opponentMarker,
      startTime: data.startTime,
      timestamp: new Date().toISOString()
    });

    const gameSession: GameSession = {
      id: lobbyId,
      creatorId: data.creatorId,
      opponentId: data.opponentId,
      creatorMarker: data.creatorMarker as 'o' | 'x',
      opponentMarker: data.opponentMarker as 'o' | 'x',
      currentTurn: data.creatorMarker,
      board: Array(10000).fill(null),
      numMoves: 0,
      pay: false,
      startedAt: Date.now(),
      playerTime1: 0,
      playerTime2: 0,
      lastMoveTime: Date.now()
    };

    console.log('📝 [CreateGameSession] Game session object created:', {
      sessionId: gameSession.id,
      creatorId: gameSession.creatorId,
      currentTurn: gameSession.currentTurn,
      boardSize: gameSession.board.length,
      timestamp: new Date().toISOString()
    });

    try {
      // Сохраняем в Redis
      await this.redis.set(`lobby:${gameSession.id}`, JSON.stringify({
        ...gameSession,
        status: 'active',
        createdAt: Date.now()
      }));

      console.log('✅ [CreateGameSession] Game session saved to Redis:', {
        sessionId: gameSession.id,
        redisKey: `lobby:${gameSession.id}`,
        ttl: await this.redis.ttl(`lobby:${gameSession.id}`),
        timestamp: new Date().toISOString()
      });

      return gameSession;
    } catch (error) {
      console.error('❌ [CreateGameSession] Error saving game session:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        sessionId: gameSession.id,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
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

  async endGameSession(gameId: string, winnerId: string, reason: string = 'unknown'): Promise<void> {
    const session = this.activeSessions.get(gameId);
    if (!session) {
      throw new Error('Game session not found');
    }

    try {
      // Создаем запись в БД только при завершении игры
      await this.prisma.game.create({
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

      // Удаляем сессию из памяти
      this.activeSessions.delete(gameId);
    } catch (error) {
      console.error('Error saving game result:', error);
      // Даже если сохранение в БД не удалось, все равно удаляем сессию
      this.activeSessions.delete(gameId);
      throw error;
    }
  }

  // Добавляем метод для периодической проверки консистентности данных
  private async cleanupStaleData(): Promise<void> {
    const lobbies = Array.from(this.activeLobbies.values());
    
    for (const lobby of lobbies) {
      const [lobbyExists, indexExists] = await Promise.all([
        this.redis.exists(lobby.id),
        this.redis.exists(`user_lobby:${lobby.creatorId}`)
      ]);
      
      if (!lobbyExists || !indexExists) {
        // Очищаем неконсистентные данные
        await this.deleteLobby(lobby.id);
        // Rate limit данные будут очищены в методе deleteLobby
      }
    }
    
    // Очищаем устаревшие rate limit данные
    const now = Date.now();
    for (const [telegramId, request] of this.userLobbyRequests.entries()) {
      if (now - request.timestamp > 60000) { // Прошла минута
        this.userLobbyRequests.delete(telegramId);
        console.log('🧹 Cleaned up expired rate limit data for:', telegramId);
      }
    }
  }

  async findLobbyByCreator(creatorId: string): Promise<Lobby | null> {
    try {
      console.log('🔍 [FindLobby] Starting search for creator:', {
        creatorId,
        timestamp: new Date().toISOString()
      });

      // Проверяем состояние Redis
      const redisState = await Promise.all([
        this.redis.keys('lobby_*'),
        this.redis.keys('user_lobby:*'),
        this.redis.keys('player:*')
      ]);

      console.log('📊 [FindLobby] Redis state:', {
        lobbies: redisState[0],
        userLobbies: redisState[1],
        players: redisState[2],
        timestamp: new Date().toISOString()
      });

      // Сначала ищем в памяти
      let latestLobby = null;
      let latestTimestamp = 0;

      for (const [_, lobby] of this.activeLobbies) {
        if (String(lobby.creatorId) === String(creatorId) && lobby.createdAt > latestTimestamp) {
          latestLobby = lobby;
          latestTimestamp = lobby.createdAt;
        }
      }

      console.log('💾 [FindLobby] Memory search result:', {
        foundInMemory: !!latestLobby,
        lobbyId: latestLobby?.id,
        timestamp: new Date().toISOString()
      });

      // Если нашли в памяти, проверяем актуальность в Redis
      if (latestLobby) {
        const lobbyData = await this.redis.get(latestLobby.id);
        if (lobbyData) {
          console.log('✅ [FindLobby] Found valid lobby in Redis:', {
            lobbyId: latestLobby.id,
            ttl: await this.redis.ttl(latestLobby.id),
            timestamp: new Date().toISOString()
          });

          // Обновляем TTL для найденного лобби
          await this.redis.expire(latestLobby.id, 180);
          await this.redis.expire(`user_lobby:${creatorId}`, 180);
          return latestLobby;
        }
        // Если в Redis нет, удаляем из памяти
        console.log('⚠️ [FindLobby] Lobby not found in Redis, removing from memory:', {
          lobbyId: latestLobby.id,
          timestamp: new Date().toISOString()
        });
        this.activeLobbies.delete(latestLobby.id);
      }

      // Если не нашли в памяти или данные устарели, ищем через индекс в Redis
      const lobbyId = await this.redis.get(`user_lobby:${creatorId}`);
      console.log('🔍 [FindLobby] Redis index search:', {
        foundLobbyId: lobbyId,
        timestamp: new Date().toISOString()
      });

      if (!lobbyId) {
        console.log('❌ [FindLobby] No lobby found for creator:', {
          creatorId,
          timestamp: new Date().toISOString()
        });
        return null;
      }

      // Получаем данные лобби
      const lobbyData = await this.redis.get(lobbyId);
      if (!lobbyData) {
        // Очищаем неактуальный индекс
        await this.redis.del(`user_lobby:${creatorId}`);
        console.log('❌ [FindLobby] No lobby data found for lobbyId:', {
          lobbyId,
          timestamp: new Date().toISOString()
        });
        return null;
      }

      try {
        const lobby = JSON.parse(lobbyData) as Lobby;
        // Проверяем TTL
        const ttl = await this.redis.ttl(lobbyId);
        
        console.log('⏱️ [FindLobby] Checking lobby TTL:', {
          lobbyId,
          ttl,
          timestamp: new Date().toISOString()
        });

        // Если TTL истек или близок к истечению, считаем лобби недействительным
        if (ttl <= 0) {
          console.log('❌ [FindLobby] Lobby TTL expired:', {
            lobbyId,
            timestamp: new Date().toISOString()
          });
          await this.deleteLobby(lobbyId);
          return null;
        }

        // Обновляем TTL для найденного лобби
        await this.redis.expire(lobbyId, 180);
        await this.redis.expire(`user_lobby:${creatorId}`, 180);

        // Сохраняем в память и возвращаем
        this.activeLobbies.set(lobby.id, lobby);
        console.log('✅ [FindLobby] Found and updated lobby:', {
          lobbyId: lobby.id,
          creatorId: lobby.creatorId,
          status: lobby.status,
          ttl: await this.redis.ttl(lobbyId),
          timestamp: new Date().toISOString()
        });
        return lobby;
      } catch (error) {
        console.error('❌ [FindLobby] Error parsing lobby data:', {
          error: error instanceof Error ? error.message : 'Unknown error',
          lobbyId,
          timestamp: new Date().toISOString()
        });
        return null;
      }
    } catch (error) {
      console.error('❌ [FindLobby] Error finding lobby by creator:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        creatorId,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  }

  /**
   * Проверяет, является ли пользователь новым
   * @param telegramId Telegram ID пользователя
   * @returns true если пользователь новый (не найден в таблице Game), false если найден
   * @throws Error если произошла ошибка при проверке
   */
  async findUserByTelegramId(telegramId: string): Promise<boolean> {
    try {
      // Ищем пользователя в таблице Game
      const existingGame = await this.prisma.game.findFirst({
        where: {
          OR: [
            {
              createdBy: String(telegramId)
            },
            {
              rival: String(telegramId)
            }
          ]
        }
      });

      return !!existingGame;
    } catch (error) {
      console.error('Error checking user in Game table:', error);
      // Пробрасываем ошибку дальше для обработки на уровне выше
      throw new Error(`Failed to check if user is new: ${error.message}`);
    }
  }

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

  async updateLobby(lobbyId: string, data: Partial<Lobby>): Promise<void> {
    const lobby = await this.getLobby(lobbyId);
    if (!lobby) {
      throw new Error(`Lobby ${lobbyId} not found`);
    }
    await this.redis.set(`lobby:${lobbyId}`, JSON.stringify({ ...lobby, ...data }));
  }

  async getGameState(lobbyId: string): Promise<GameState> {
    const gameSession = await this.getGameSession(lobbyId);
    if (!gameSession) {
      throw new Error(`Game session not found for lobby ${lobbyId}`);
    }

    return {
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
        lobbyId
      }
    };
  }
} 
