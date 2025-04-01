import { PartialType, OmitType, ApiProperty } from '@nestjs/swagger';
import { CreateTaskDto } from './create-task.dto';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateTaskDto extends PartialType(OmitType(CreateTaskDto, ['userId'])) {
  @ApiProperty({
    enum: ['pending', 'completed', 'cancelled'],
    description: 'Task status',
    required: false,
  })
  @IsOptional()
  @IsEnum(['pending', 'completed', 'cancelled'])
  status?: 'pending' | 'completed' | 'cancelled';
}