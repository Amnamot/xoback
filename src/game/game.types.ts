export const MAX_MOVE_TIME = 30000; // 30 seconds

export interface Lobby {
  id: string;
  creatorId: string;
  opponentId?: string;
  status: 'pending' | 'active' | 'closed';
  createdAt: number;
}

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

export interface GameSession {
  id: string;
  lobbyId: string;
  creatorId: string;
  opponentId: string;
  creatorMarker: string;
  opponentMarker: string;
  startTime: number;
  board: Record<string, string>;
  currentTurn: string;
  lastMoveTime: number;
  playerTime1: number;
  playerTime2: number;
} 