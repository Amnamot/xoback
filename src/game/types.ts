// Возможные статусы лобби
export type LobbyStatus = 'active' | 'pending' | 'wait';

// Структура лобби (временное состояние ожидания)
export interface Lobby {
  id: string;           // ID лобби
  creatorId: string;    // telegramId создателя
  createdAt: number;    // время создания
  status: LobbyStatus;  // статус лобби
  opponentId?: string;  // telegramId соперника (только для статуса wait)
}

// Валидация переходов статусов
export const VALID_STATUS_TRANSITIONS: Record<LobbyStatus, LobbyStatus[]> = {
  'active': ['pending', 'wait'],
  'pending': ['active'],
  'wait': ['active']
};

// Константы TTL для разных состояний лобби
export const LOBBY_TTL = 180; // 3 минуты для активного лобби
export const PENDING_TTL = 30; // 30 секунд для pending состояния
export const WAIT_TTL = 30; // 30 секунд для wait состояния

// Лимиты для переходов состояний
export const TRANSITION_LIMITS = {
  MAX_PER_MINUTE: 5,      // максимум переходов в минуту
  WINDOW_MS: 60000,       // окно в миллисекундах (1 минута)
  CLEANUP_LOCK_TTL: 60,   // TTL для блокировки очистки (в секундах)
  MAX_RETRIES: 3         // максимум попыток для операций
};

// Интерфейс для отслеживания переходов
export interface StatusTransitionLimit {
  count: number;
  timestamp: number;
  lastStatus?: LobbyStatus;
}

// Интерфейс для метрик очистки
export interface CleanupMetrics {
  checked: number;
  cleaned: number;
  errors: number;
  startTime: number;
  endTime?: number;
}

// Расширяем REDIS_KEYS
export const REDIS_KEYS = {
  LOBBY: (id: string) => id,
  USER_LOBBY: (userId: string) => `user_lobby:${userId}`,
  PENDING: (id: string) => `pending:${id}`,
  WAIT: (id: string) => `wait:${id}`,
  OPPONENT: (id: string) => `opponent:${id}`,
  ACTIVE_LOBBIES: 'active_lobbies',
  LOBBIES_BY_STATUS: (status: LobbyStatus) => `lobbies:${status}`,
  CLEANUP_LOCK: 'cleanup_lock',
  TRANSITION_LIMIT: (lobbyId: string) => `transition_limit:${lobbyId}`,
  BACKUP: (lobbyId: string) => `backup:${lobbyId}`
};

// Причины ошибок при переходах состояний
export enum TransitionError {
  NOT_FOUND = 'LOBBY_NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED_ACCESS',
  INVALID_TRANSITION = 'INVALID_TRANSITION',
  RATE_LIMIT = 'RATE_LIMIT_EXCEEDED',
  MISSING_OPPONENT = 'MISSING_OPPONENT',
  REDIS_ERROR = 'REDIS_ERROR',
  BACKUP_FAILED = 'BACKUP_FAILED',
  RESTORE_FAILED = 'RESTORE_FAILED'
}

// Структура активной игровой сессии
export interface GameSession {
  // Идентификация
  id: string;                    // ID игры (тот же, что был у лобби)
  dbId?: number;                 // ID в базе данных (после записи)
  
  // Игроки
  creatorId: string;            // telegramId создателя (createdBy в БД)
  opponentId: string;           // telegramId соперника (rival в БД)
  
  // Состояние игры
  currentTurn: string;          // чей сейчас ход
  board: any;                   // состояние доски
  numMoves: number;             // количество сделанных ходов
  pay: boolean;                 // игра за Stars
  
  // Время
  startedAt: number;           // время начала игры
  playerTime1: number;         // текущее время первого игрока
  playerTime2: number;         // текущее время второго игрока
  lastMoveTime: number;        // время последнего хода
} 