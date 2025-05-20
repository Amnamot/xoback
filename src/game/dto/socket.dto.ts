import { IsString, IsNumber, IsObject, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class ConnectDto {
    @IsString()
    telegramId: string;
}

export class CreateLobbyDto {
    @IsString()
    telegramId: string;
}

export class JoinLobbyDto {
    @IsString()
    lobbyId: string;

    @IsString()
    telegramId: string;

    @IsString()
    @IsOptional()
    avatar?: string;

    @IsString()
    @IsOptional()
    name?: string;
}

export class PositionDto {
    @IsNumber()
    row: number;

    @IsNumber()
    col: number;
}

export class MakeMoveDto {
    @IsString()
    gameId: string;

    @ValidateNested()
    @Type(() => PositionDto)
    position: PositionDto;

    @IsString()
    player: string;

    @IsNumber()
    moveTime: number;
}

export class PlayerTimesDto {
    @IsNumber()
    playerTime1: number;

    @IsNumber()
    playerTime2: number;
}

export class UpdatePlayerTimeDto {
    @IsString()
    gameId: string;

    @ValidateNested()
    @Type(() => PlayerTimesDto)
    playerTimes: PlayerTimesDto;
}

export class ViewportDto {
    @IsNumber()
    scale: number;

    @IsObject()
    position: { x: number; y: number };
}

export class UpdateViewportDto {
    @IsString()
    gameId: string;

    @ValidateNested()
    @Type(() => ViewportDto)
    viewport: ViewportDto;
}

export class GameOverDto {
    @IsString()
    gameId: string;

    @IsString()
    winner: string;
}

export class JoinGameDto {
    @IsString()
    gameId: string;

    @IsString()
    telegramId: string;
}

export class TimeExpiredDto {
    @IsString()
    gameId: string;

    @IsString()
    player: string;
}

export class CreateInviteDto {
    @IsString()
    telegramId: string;
}

export class CancelLobbyDto {
    @IsString()
    telegramId: string;
}

export class GameStartDto {
    @IsString()
    gameId: string;

    @IsNumber()
    startTime: number;
} 