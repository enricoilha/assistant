import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsDate, IsOptional, IsArray, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateTaskDto {
  @ApiProperty({ description: 'User ID (automatically set by server)' })
  @IsString()
  userId: string;

  @ApiProperty({ example: 'Doctor appointment', description: 'Task title' })
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiProperty({
    example: 'Annual checkup with Dr. Smith',
    description: 'Task description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: '2023-08-15T14:30:00Z',
    description: 'Task scheduled date and time',
  })
  @IsNotEmpty()
  @IsDate()
  @Type(() => Date)
  scheduledDate: Date;

  @ApiProperty({
    example: 'Medical Center, Floor 3',
    description: 'Task location',
    required: false,
  })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiProperty({
    example: ['John', 'Mary'],
    description: 'Task participants',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  participants?: string[];
}