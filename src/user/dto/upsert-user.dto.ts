// src/user/dto/upsert-user.dto.ts v1
import { IsString, IsOptional } from 'class-validator';

export class UpsertUserDto {
    @IsString()
    telegramId: string;

    @IsString()
    @IsOptional()
    userName?: string;

    @IsString()
    firstName: string;

    @IsString()
    lastName: string;

    @IsString()
    @IsOptional()
    avatar?: string;
}
  