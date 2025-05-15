import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { 
  GameSession, 
  Lobby, 
  LobbyStatus, 
  VALID_STATUS_TRANSITIONS, 
  LOBBY_TTL,
  PENDING_TTL,
  WAIT_TTL,
  REDIS_KEYS,
  TRANSITION_LIMITS,
  StatusTransitionLimit,
  CleanupMetrics,
  TransitionError
} from './types';

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

    // Запускаем очистку при старте сервиса
    this.cleanupInvalidLobbies();
    
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

    // Проверяем существующие лобби через индекс
    const existingLobbyId = await this.redis.get(REDIS_KEYS.USER_LOBBY(telegramId));
    if (existingLobbyId) {
      const lobbyData = await this.redis.get(REDIS_KEYS.LOBBY(existingLobbyId));
      if (lobbyData) {
        try {
          const lobby = JSON.parse(lobbyData);
          this.activeLobbies.set(existingLobbyId, lobby);
          console.log('📝 Restored lobby from Redis to memory', {
            telegramId,
            lobbyId: existingLobbyId,
            lobbyData: lobby,
            timestamp: new Date().toISOString()
          });
          return false;
        } catch (error) {
          console.error('❌ Error parsing lobby data:', error);
        }
      }
      // Если лобби не найдено, но индекс есть - очищаем индекс
      console.warn('⚠️ Lobby index exists but lobby not found, cleaning up', {
        telegramId,
        lobbyId: existingLobbyId,
        timestamp: new Date().toISOString()
      });
      await this.redis.del(REDIS_KEYS.USER_LOBBY(telegramId));
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

  private async validateLobbyState(
    lobbyId: string,
    newStatus: LobbyStatus,
    telegramId: string
  ): Promise<boolean> {
    const lobby = await this.getLobby(lobbyId);
    if (!lobby) {
      console.warn('❌ Lobby not found:', lobbyId);
      throw new Error(TransitionError.NOT_FOUND);
    }
    
    // Проверка прав доступа
    if (lobby.creatorId !== telegramId) {
      console.warn('❌ Unauthorized status transition attempt:', {
        lobbyId,
        attemptedBy: telegramId,
        ownedBy: lobby.creatorId
      });
      throw new Error(TransitionError.UNAUTHORIZED);
    }
    
    // Проверка лимита переходов
    if (!await this.checkTransitionLimit(lobbyId)) {
      throw new Error(TransitionError.RATE_LIMIT);
    }
    
    // Проверка допустимости перехода
    if (!VALID_STATUS_TRANSITIONS[lobby.status].includes(newStatus)) {
      console.warn('❌ Invalid status transition:', {
        lobbyId,
        currentStatus: lobby.status,
        newStatus,
        allowedTransitions: VALID_STATUS_TRANSITIONS[lobby.status]
      });
      throw new Error(TransitionError.INVALID_TRANSITION);
    }
    
    // Проверка наличия оппонента для wait статуса
    if (newStatus === 'wait' && !lobby.opponentId) {
      console.warn('❌ Cannot transition to wait status without opponent:', {
        lobbyId,
        currentStatus: lobby.status,
        opponentId: lobby.opponentId
      });
      throw new Error(TransitionError.MISSING_OPPONENT);
    }
    
    return true;
  }

  private async indexLobby(lobby: Lobby): Promise<void> {
    console.log('📑 Indexing lobby:', {
      lobbyId: lobby.id,
      status: lobby.status,
      creatorId: lobby.creatorId,
      opponentId: lobby.opponentId
    });

    const multi = this.redis.multi();
    
    // Основной индекс активных лобби
    multi.sadd(REDIS_KEYS.ACTIVE_LOBBIES, lobby.id);
    
    // Индекс по статусу
    multi.sadd(REDIS_KEYS.LOBBIES_BY_STATUS(lobby.status), lobby.id);
    
    // Индекс по пользователю
    multi.set(REDIS_KEYS.USER_LOBBY(lobby.creatorId), lobby.id, 'EX', LOBBY_TTL);
    
    if (lobby.opponentId) {
      multi.set(REDIS_KEYS.USER_LOBBY(lobby.opponentId), lobby.id, 'EX', LOBBY_TTL);
    }
    
    const results = await multi.exec();
    if (!results || results.some(result => !result[1])) {
      console.error('❌ Failed to index lobby:', {
        lobbyId: lobby.id,
        results
      });
      throw new Error('Failed to index lobby');
    }
  }

  private async cleanupLobbyIndices(lobby: Lobby): Promise<void> {
    console.log('🧹 Cleaning up lobby indices:', {
      lobbyId: lobby.id,
      status: lobby.status,
      creatorId: lobby.creatorId,
      opponentId: lobby.opponentId
    });

    const multi = this.redis.multi();
    
    // Удаляем из всех индексов
    multi.srem(REDIS_KEYS.ACTIVE_LOBBIES, lobby.id);
    multi.srem(REDIS_KEYS.LOBBIES_BY_STATUS(lobby.status), lobby.id);
    multi.del(REDIS_KEYS.USER_LOBBY(lobby.creatorId));
    
    if (lobby.opponentId) {
      multi.del(REDIS_KEYS.USER_LOBBY(lobby.opponentId));
    }
    
    const results = await multi.exec();
    if (!results || results.some(result => !result[1])) {
      console.warn('⚠️ Some lobby indices cleanup failed:', {
        lobbyId: lobby.id,
        results
      });
    }
  }

  async updateLobbyTTL(lobbyId: string): Promise<void> {
    console.log('⏰ Updating lobby TTL:', { lobbyId });
    
    const lobby = await this.getLobby(lobbyId);
    if (!lobby) {
      console.warn('❌ Cannot update TTL for non-existent lobby:', { lobbyId });
      return;
    }

    const multi = this.redis.multi();
    
    // Обновляем TTL для основных данных
    multi.expire(REDIS_KEYS.LOBBY(lobbyId), LOBBY_TTL);
    multi.expire(REDIS_KEYS.USER_LOBBY(lobby.creatorId), LOBBY_TTL);
    
    // Обновляем TTL для статусов
    if (lobby.status === 'pending') {
      multi.expire(REDIS_KEYS.PENDING(lobbyId), PENDING_TTL);
    }
    if (lobby.status === 'wait') {
      multi.expire(REDIS_KEYS.WAIT(lobbyId), WAIT_TTL);
    }
    
    // Обновляем TTL для оппонента
    if (lobby.opponentId) {
      multi.expire(REDIS_KEYS.OPPONENT(lobbyId), LOBBY_TTL);
      multi.expire(REDIS_KEYS.USER_LOBBY(lobby.opponentId), LOBBY_TTL);
    }
    
    const results = await multi.exec();
    if (!results || results.some(result => !result[1])) {
      console.warn('⚠️ Some TTL updates failed:', {
        lobbyId,
        results
      });
    }
  }

  async createLobby(creatorId: string): Promise<Lobby | null> {
    console.log('🎮 Creating new lobby for:', creatorId);

    try {
      // Проверяем существующие лобби через индекс
      const existingLobbyId = await this.redis.get(REDIS_KEYS.USER_LOBBY(creatorId));
      if (existingLobbyId) {
        console.warn('⚠️ User already has active lobby:', {
          creatorId,
          existingLobbyId
        });
        return null;
      }

      const lobbyId = `lobby_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const lobby: Lobby = {
        id: lobbyId,
        creatorId,
        createdAt: Date.now(),
        status: 'active'
      };

      // Используем WATCH для атомарных операций
      const result = await this.redis
        .multi()
        .watch(REDIS_KEYS.LOBBY(lobbyId), REDIS_KEYS.USER_LOBBY(creatorId))
        .set(REDIS_KEYS.LOBBY(lobbyId), JSON.stringify(lobby), 'EX', LOBBY_TTL)
        .set(REDIS_KEYS.USER_LOBBY(creatorId), lobbyId, 'EX', LOBBY_TTL)
        .exec();

      if (!result || result.some(r => !r[1])) {
        console.error('❌ Failed to create lobby:', {
          lobbyId,
          creatorId,
          result
        });
        return null;
      }

      // Индексируем лобби
      await this.indexLobby(lobby);

      // Сохраняем в памяти
      this.activeLobbies.set(lobbyId, lobby);

      console.log('✅ Lobby created successfully:', {
        lobbyId,
        creatorId
      });

      return lobby;
    } catch (error) {
      console.error('❌ Error creating lobby:', error);
      return null;
    }
  }

  async getLobby(lobbyId: string): Promise<Lobby | null> {
    try {
      // Сначала проверяем в памяти
      const memoryLobby = this.activeLobbies.get(lobbyId);
      if (memoryLobby) {
        return memoryLobby;
      }

      // Если нет в памяти, пробуем получить из Redis
      const lobbyData = await this.redis.get(REDIS_KEYS.LOBBY(lobbyId));
      if (!lobbyData) {
        return null;
      }

      try {
        const lobby: Lobby = JSON.parse(lobbyData);
        
        // Проверяем TTL
        const ttl = await this.redis.ttl(REDIS_KEYS.LOBBY(lobbyId));
        if (ttl <= 0) {
          await this.deleteLobby(lobbyId);
          return null;
        }

        // Проверяем статус и связанные данные
        if (lobby.status === 'pending') {
          const hasPending = await this.redis.exists(REDIS_KEYS.PENDING(lobbyId));
          if (!hasPending) {
            await this.deleteLobby(lobbyId);
            return null;
          }
        } else if (lobby.status === 'wait') {
          const hasWait = await this.redis.exists(REDIS_KEYS.WAIT(lobbyId));
          if (!hasWait) {
            await this.deleteLobby(lobbyId);
            return null;
          }
        }

        // Сохраняем в память и возвращаем
        this.activeLobbies.set(lobbyId, lobby);
        return lobby;
      } catch (error) {
        console.error('❌ Error parsing lobby data:', error);
        return null;
      }
    } catch (error) {
      console.error('Error getting lobby:', error);
      return null;
    }
  }

  async markLobbyPending(lobbyId: string): Promise<void> {
    console.log('⏳ Marking lobby as pending/wait:', lobbyId);
    
    try {
      const lobby = await this.getLobby(lobbyId);
      if (lobby) {
        // Определяем статус на основе наличия оппонента
        const newStatus = lobby.opponentId ? 'wait' : 'pending';
        
        // Проверяем валидность перехода
        if (!await this.validateLobbyState(lobbyId, newStatus, lobby.creatorId)) {
          throw new Error(`Invalid status transition from ${lobby.status} to ${newStatus}`);
        }

        lobby.status = newStatus;
        
        const multi = this.redis.multi();
        
        // Основной TTL лобби
        multi.set(REDIS_KEYS.LOBBY(lobbyId), JSON.stringify(lobby), 'EX', LOBBY_TTL);
        multi.set(REDIS_KEYS.USER_LOBBY(lobby.creatorId), lobbyId, 'EX', LOBBY_TTL);

        if (newStatus === 'wait' && lobby.opponentId) {
          multi.set(REDIS_KEYS.OPPONENT(lobbyId), lobby.opponentId, 'EX', LOBBY_TTL);
          multi.set(REDIS_KEYS.WAIT(lobbyId), '1', 'EX', WAIT_TTL);
        } else {
          multi.set(REDIS_KEYS.PENDING(lobbyId), '1', 'EX', PENDING_TTL);
        }
        
        const results = await multi.exec();
        
        if (!results || results.some(result => !result[1])) {
          console.error('❌ Redis transaction failed:', results);
          throw new Error('Failed to mark lobby as pending/wait');
        }
        
        // Обновляем индексы
        await this.indexLobby(lobby);
        
        console.log('✅ Lobby marked as ' + newStatus + ':', lobbyId);
      }
    } catch (error) {
      console.error('❌ Error marking lobby as pending/wait:', error);
      throw error;
    }
  }

  async restoreLobby(lobbyId: string): Promise<void> {
    try {
      const lobby = await this.getLobby(lobbyId);
      if (lobby) {
        // Проверяем валидность перехода
        if (!await this.validateLobbyState(lobbyId, 'active', lobby.creatorId)) {
          throw new Error(`Invalid status transition from ${lobby.status} to active`);
        }

        lobby.status = 'active';
        
        const multi = this.redis.multi();
        
        // Восстанавливаем TTL в Redis
        multi.set(REDIS_KEYS.LOBBY(lobbyId), JSON.stringify(lobby), 'EX', LOBBY_TTL);
        multi.set(REDIS_KEYS.USER_LOBBY(lobby.creatorId), lobbyId, 'EX', LOBBY_TTL);
        
        if (lobby.opponentId) {
          multi.set(REDIS_KEYS.OPPONENT(lobbyId), lobby.opponentId, 'EX', LOBBY_TTL);
        }
        
        const results = await multi.exec();
        if (!results || results.some(result => !result[1])) {
          throw new Error('Failed to restore lobby');
        }
        
        // Обновляем индексы
        await this.indexLobby(lobby);
        
        this.activeLobbies.set(lobbyId, lobby);
      }
    } catch (error) {
      console.error('Error restoring lobby:', error);
      throw error;
    }
  }

  async deleteLobby(lobbyId: string): Promise<void> {
    console.log('🗑️ Deleting lobby:', lobbyId);

    try {
      const lobby = await this.getLobby(lobbyId);
      if (!lobby) {
        console.warn('⚠️ Lobby not found for deletion:', lobbyId);
        return;
      }

      // Очищаем индексы перед удалением
      await this.cleanupLobbyIndices(lobby);

      const multi = this.redis.multi();
      
      // Удаляем все связанные данные
      multi.del(REDIS_KEYS.LOBBY(lobbyId));
      multi.del(REDIS_KEYS.PENDING(lobbyId));
      multi.del(REDIS_KEYS.WAIT(lobbyId));
      multi.del(REDIS_KEYS.OPPONENT(lobbyId));
      
      const results = await multi.exec();
      if (!results || results.some(result => !result[1])) {
        console.warn('⚠️ Some lobby deletions failed:', {
          lobbyId,
          results
        });
      }

      // Очищаем из памяти
      this.activeLobbies.delete(lobbyId);

      console.log('✅ Lobby deleted successfully:', lobbyId);
    } catch (error) {
      console.error('❌ Error deleting lobby:', error);
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
    if (!await this.acquireCleanupLock()) {
      console.log('🔒 Cleanup already running');
      return;
    }

    const metrics: CleanupMetrics = {
      checked: 0,
      cleaned: 0,
      errors: 0,
      startTime: Date.now()
    };
    
    try {
      const activeLobbies = await this.redis.smembers(REDIS_KEYS.ACTIVE_LOBBIES);
      
      for (const lobbyId of activeLobbies) {
        metrics.checked++;
        
        try {
          const lobbyData = await this.redis.get(REDIS_KEYS.LOBBY(lobbyId));
          
          if (!lobbyData) {
            await this.deleteLobby(lobbyId);
            metrics.cleaned++;
            continue;
          }
          
          const lobby = JSON.parse(lobbyData);
          
          // Проверяем все связанные данные
          const [hasPending, hasWait, hasOpponent] = await Promise.all([
            this.redis.exists(REDIS_KEYS.PENDING(lobbyId)),
            this.redis.exists(REDIS_KEYS.WAIT(lobbyId)),
            this.redis.exists(REDIS_KEYS.OPPONENT(lobbyId))
          ]);
          
          let needsCleanup = false;
          
          // Проверяем консистентность статусов
          if (lobby.status === 'pending' && !hasPending) needsCleanup = true;
          if (lobby.status === 'wait' && !hasWait) needsCleanup = true;
          if (lobby.opponentId && !hasOpponent) needsCleanup = true;
          
          if (needsCleanup) {
            await this.deleteLobby(lobbyId);
            metrics.cleaned++;
          }
        } catch (error) {
          console.error('❌ Error processing lobby during cleanup:', {
            lobbyId,
            error
          });
          metrics.errors++;
        }
      }
    } catch (error) {
      console.error('❌ Error during cleanup:', error);
      metrics.errors++;
    } finally {
      metrics.endTime = Date.now();
      
      console.log('📊 Cleanup completed:', {
        duration: metrics.endTime - metrics.startTime,
        ...metrics
      });
      
      // Освобождаем блокировку
      await this.redis.del(REDIS_KEYS.CLEANUP_LOCK);
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

  async setLobbyOpponent(lobbyId: string, opponentId: string): Promise<void> {
    console.log('👥 Setting lobby opponent:', { lobbyId, opponentId });
    
    try {
      const lobby = await this.getLobby(lobbyId);
      if (!lobby) {
        throw new Error('Lobby not found');
      }

      lobby.opponentId = opponentId;
      
      const multi = this.redis.multi();
      
      // Обновляем данные лобби с новым оппонентом
      multi.set(REDIS_KEYS.LOBBY(lobbyId), JSON.stringify(lobby), 'EX', LOBBY_TTL);
      multi.set(REDIS_KEYS.OPPONENT(lobbyId), opponentId, 'EX', LOBBY_TTL);
      multi.set(REDIS_KEYS.USER_LOBBY(opponentId), lobbyId, 'EX', LOBBY_TTL);
      
      const results = await multi.exec();
      
      if (!results || results.some(result => !result[1])) {
        console.error('❌ Redis transaction failed:', results);
        throw new Error('Failed to set lobby opponent');
      }
      
      // Обновляем индексы
      await this.indexLobby(lobby);
      
      console.log('✅ Lobby opponent set:', { lobbyId, opponentId });
    } catch (error) {
      console.error('❌ Error setting lobby opponent:', error);
      throw error;
    }
  }

  // Проверка прав на изменение лобби
  private async validateLobbyAccess(lobbyId: string, telegramId: string): Promise<boolean> {
    const lobby = await this.getLobby(lobbyId);
    return lobby?.creatorId === telegramId;
  }

  // Атомарное обновление статуса лобби
  private async updateLobbyStatusAtomic(lobbyId: string, newStatus: LobbyStatus, opponentId?: string): Promise<void> {
    const multi = this.redis.multi();
    
    // Обновляем основные данные
    multi.set(REDIS_KEYS.LOBBY(lobbyId), JSON.stringify({
      id: lobbyId,
      status: newStatus,
      ...(opponentId && { opponentId })
    }), 'EX', LOBBY_TTL);
    
    // Обновляем статусы
    if (newStatus === 'pending') {
      multi.set(REDIS_KEYS.PENDING(lobbyId), '1', 'EX', PENDING_TTL);
      multi.del(REDIS_KEYS.WAIT(lobbyId));
    } else if (newStatus === 'wait') {
      multi.set(REDIS_KEYS.WAIT(lobbyId), '1', 'EX', WAIT_TTL);
      multi.del(REDIS_KEYS.PENDING(lobbyId));
    } else {
      multi.del(REDIS_KEYS.PENDING(lobbyId));
      multi.del(REDIS_KEYS.WAIT(lobbyId));
    }
    
    // Обновляем данные оппонента
    if (opponentId) {
      multi.set(REDIS_KEYS.OPPONENT(lobbyId), opponentId, 'EX', LOBBY_TTL);
    }
    
    const results = await multi.exec();
    if (!results || results.some(result => !result[1])) {
      throw new Error('Failed to update lobby status atomically');
    }
  }

  // Публичный метод для обновления статуса
  async updateLobbyStatus(
    lobbyId: string,
    newStatus: LobbyStatus,
    telegramId: string
  ): Promise<void> {
    console.log('🔄 Updating lobby status:', { lobbyId, newStatus, telegramId });
    
    try {
      const lobby = await this.getLobby(lobbyId);
      if (!lobby) {
        throw new Error(TransitionError.NOT_FOUND);
      }

      // Валидация с проверками безопасности
      await this.validateLobbyState(lobbyId, newStatus, telegramId);
      
      // Создаем бэкап текущего состояния
      if (!await this.backupLobbyState(lobby)) {
        throw new Error(TransitionError.BACKUP_FAILED);
      }

      try {
        lobby.status = newStatus;
        
        const multi = this.redis.multi();
        
        // Обновляем основные данные
        multi.set(REDIS_KEYS.LOBBY(lobbyId), JSON.stringify(lobby), 'EX', LOBBY_TTL);
        
        // Обновляем статусы
        if (newStatus === 'pending') {
          multi.set(REDIS_KEYS.PENDING(lobbyId), '1', 'EX', PENDING_TTL);
          multi.del(REDIS_KEYS.WAIT(lobbyId));
        } else if (newStatus === 'wait') {
          multi.set(REDIS_KEYS.WAIT(lobbyId), '1', 'EX', WAIT_TTL);
          multi.del(REDIS_KEYS.PENDING(lobbyId));
        } else {
          multi.del(REDIS_KEYS.PENDING(lobbyId));
          multi.del(REDIS_KEYS.WAIT(lobbyId));
        }
        
        const results = await multi.exec();
        if (!results || results.some(result => !result[1])) {
          throw new Error(TransitionError.REDIS_ERROR);
        }
        
        // Обновляем индексы
        await this.indexLobby(lobby);
        
        console.log('✅ Lobby status updated:', { lobbyId, newStatus });
      } catch (error) {
        // В случае ошибки пытаемся восстановить состояние
        if (!await this.restoreLobbyState(lobbyId)) {
          throw new Error(TransitionError.RESTORE_FAILED);
        }
        throw error;
      }
    } catch (error) {
      console.error('❌ Error updating lobby status:', error);
      throw error;
    }
  }

  private async checkTransitionLimit(lobbyId: string): Promise<boolean> {
    const now = Date.now();
    
    try {
      // Получаем текущий лимит из Redis
      const limitData = await this.redis.get(REDIS_KEYS.TRANSITION_LIMIT(lobbyId));
      let limit: StatusTransitionLimit;
      
      if (!limitData) {
        limit = { count: 1, timestamp: now };
      } else {
        limit = JSON.parse(limitData);
        
        // Проверяем временное окно
        if (now - limit.timestamp > TRANSITION_LIMITS.WINDOW_MS) {
          limit = { count: 1, timestamp: now };
        } else if (limit.count >= TRANSITION_LIMITS.MAX_PER_MINUTE) {
          console.warn('⚠️ Rate limit exceeded for lobby transitions:', {
            lobbyId,
            currentCount: limit.count,
            windowStart: new Date(limit.timestamp).toISOString()
          });
          return false;
        } else {
          limit.count++;
        }
      }
      
      // Сохраняем обновленный лимит
      await this.redis.set(
        REDIS_KEYS.TRANSITION_LIMIT(lobbyId),
        JSON.stringify(limit),
        'EX',
        Math.ceil(TRANSITION_LIMITS.WINDOW_MS / 1000)
      );
      
      return true;
    } catch (error) {
      console.error('❌ Error checking transition limit:', error);
      return false;
    }
  }

  private async backupLobbyState(lobby: Lobby): Promise<boolean> {
    try {
      await this.redis.set(
        REDIS_KEYS.BACKUP(lobby.id),
        JSON.stringify(lobby),
        'EX',
        LOBBY_TTL
      );
      return true;
    } catch (error) {
      console.error('❌ Error backing up lobby state:', error);
      return false;
    }
  }

  private async restoreLobbyState(lobbyId: string): Promise<boolean> {
    try {
      const backupData = await this.redis.get(REDIS_KEYS.BACKUP(lobbyId));
      if (!backupData) {
        console.warn('⚠️ No backup found for lobby:', lobbyId);
        return false;
      }

      const backup: Lobby = JSON.parse(backupData);
      const multi = this.redis.multi();
      
      // Восстанавливаем основные данные
      multi.set(REDIS_KEYS.LOBBY(lobbyId), backupData, 'EX', LOBBY_TTL);
      multi.set(REDIS_KEYS.USER_LOBBY(backup.creatorId), lobbyId, 'EX', LOBBY_TTL);
      
      // Восстанавливаем статусы
      if (backup.status === 'pending') {
        multi.set(REDIS_KEYS.PENDING(lobbyId), '1', 'EX', PENDING_TTL);
        multi.del(REDIS_KEYS.WAIT(lobbyId));
      } else if (backup.status === 'wait') {
        multi.set(REDIS_KEYS.WAIT(lobbyId), '1', 'EX', WAIT_TTL);
        multi.del(REDIS_KEYS.PENDING(lobbyId));
      }
      
      if (backup.opponentId) {
        multi.set(REDIS_KEYS.OPPONENT(lobbyId), backup.opponentId, 'EX', LOBBY_TTL);
        multi.set(REDIS_KEYS.USER_LOBBY(backup.opponentId), lobbyId, 'EX', LOBBY_TTL);
      }
      
      const results = await multi.exec();
      if (!results || results.some(result => !result[1])) {
        console.error('❌ Failed to restore lobby state:', lobbyId);
        return false;
      }
      
      // Восстанавливаем в памяти
      this.activeLobbies.set(lobbyId, backup);
      
      return true;
    } catch (error) {
      console.error('❌ Error restoring lobby state:', error);
      return false;
    }
  }

  private async acquireCleanupLock(): Promise<boolean> {
    try {
      // Используем setnx вместо set с опцией NX
      const locked = await this.redis.setnx(
        REDIS_KEYS.CLEANUP_LOCK,
        Date.now().toString()
      );
      
      if (locked) {
        // Если успешно установили блокировку, устанавливаем TTL
        await this.redis.expire(
          REDIS_KEYS.CLEANUP_LOCK,
          TRANSITION_LIMITS.CLEANUP_LOCK_TTL
        );
      }
      
      return locked === 1;
    } catch (error) {
      console.error('❌ Error acquiring cleanup lock:', error);
      return false;
    }
  }

  // Очистка некорректных лобби
  private async cleanupInvalidLobbies(): Promise<void> {
    console.log('🧹 Starting cleanup of invalid lobbies');
    
    try {
      // Получаем все активные лобби
      const lobbies = Array.from(this.activeLobbies.values());
      
      for (const lobby of lobbies) {
        if (!lobby.creatorId || lobby.creatorId === 'undefined') {
          console.log('🗑️ Removing invalid lobby:', {
            lobbyId: lobby.id,
            creatorId: lobby.creatorId,
            timestamp: new Date().toISOString()
          });
          
          await this.deleteLobby(lobby.id);
        }
      }
      
      // Очищаем индексы в Redis
      const keys = await this.redis.keys('lobby_*');
      for (const key of keys) {
        const lobbyData = await this.redis.get(key);
        if (lobbyData) {
          try {
            const lobby = JSON.parse(lobbyData);
            if (!lobby.creatorId || lobby.creatorId === 'undefined') {
              console.log('🗑️ Removing invalid Redis lobby:', {
                lobbyId: key,
                creatorId: lobby.creatorId,
                timestamp: new Date().toISOString()
              });
              await this.deleteLobby(key);
            }
          } catch (error) {
            console.error('❌ Error parsing lobby data during cleanup:', {
              error: error.message,
              lobbyId: key,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
      
      console.log('✅ Invalid lobbies cleanup completed');
    } catch (error) {
      console.error('❌ Error during invalid lobbies cleanup:', {
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
} 