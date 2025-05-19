import { Injectable } from '@nestjs/common';

@Injectable()
export class InitDataService {
  validateInitData(initData: string): boolean {
    try {
      const decoded = decodeURIComponent(initData);
      const params = new URLSearchParams(decoded);
      const user = params.get('user');
      return !!user;
    } catch {
      return false;
    }
  }

  parseInitData(initData: string): any {
    const decoded = decodeURIComponent(initData);
    const params = new URLSearchParams(decoded);
    const userRaw = params.get('user');
    const user = userRaw ? JSON.parse(userRaw) : null;
    return { user };
  }
}

export type InitDataParsed = ReturnType<typeof InitDataService.prototype.parseInitData>;
