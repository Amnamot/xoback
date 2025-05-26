// Константы
export const MAX_MOVE_TIME = 30000; // 30 секунд

// Структура лобби (временное состояние ожидания)
export interface Lobby {
  id: string;           // ID лобби
  creatorId: string;    // telegramId создателя
  opponentId?: string;  // telegramId соперника (опциональное)
  createdAt: number;    // время создания
  status: 'active' | 'pending' | 'closed';  // статус лобби
}

// Структура состояния игры
export interface GameState {
  board: Record<string, string>;
  currentPlayer: string;
  scale: number;
  position: { x: number; y: number };
  time: number;
  playerTime1: number;
  playerTime2: number;
  startTime: number;
  lastMoveTime: number;
  maxMoveTime: number;
  gameSession: {
    id: string;
    creatorId: string;
    opponentId: string;
    lobbyId: string;
  };
}

// Структура активной игровой сессии
export interface GameSession {
  // Идентификация
  id: string;                    // ID игры (тот же, что был у лобби)
  lobbyId: string;              // ID лобби, из которого создана игра
  
  // Игроки
  creatorId: string;            // telegramId создателя (createdBy в БД)
  opponentId: string;           // telegramId соперника (rival в БД)
  creatorMarker: string;        // маркер создателя (❌ или ⭕)
  opponentMarker: string;       // маркер соперника (❌ или ⭕)
  
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