// src/types.ts v1
import { Request } from 'express';
import { InitDataParsed } from './utils/init-data.service';

export interface RequestWithAuth extends Request {
  tgId: string;
  initData: InitDataParsed;
}
