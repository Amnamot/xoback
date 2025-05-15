import { Socket } from 'socket.io';

export interface SocketWithAuth extends Socket {
  telegramId: string;
  firstName?: string;
  username?: string;
} 