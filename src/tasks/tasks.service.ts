import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { Task } from './entities/task.entity';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notificationsService: NotificationsService,
  ) {}

  async createTask(createTaskDto: CreateTaskDto): Promise<Task> {
    try {
      const { 
        userId, 
        title, 
        description, 
        scheduledDate, 
        location, 
        participants 
      } = createTaskDto;

      // Insert task into the database
      const { data, error } = await this.supabaseService.client
        .from('tasks')
        .insert([
          {
            user_id: userId,
            title,
            description,
            scheduled_date: scheduledDate.toLocaleString('pt-BR'),
            location,
            participants,
            status: 'pending',
          },
        ])
        .select()
        .single();

      if (error) {
        this.logger.error(`Error creating task: ${error.message}`, error);
        throw new Error(`Failed to create task: ${error.message}`);
      }

      return this.mapDbTaskToEntity(data);
    } catch (error) {
      this.logger.error(`Error in createTask: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findAllByPhone(phoneNumber: string): Promise<Task[]> {
    try {
      // First, get the user ID from the phone number
      const { data: userData, error: userError } = await this.supabaseService.client
        .from('users')
        .select('id')
        .eq('phone_number', phoneNumber)
        .single();

      if (userError || !userData) {
        this.logger.error(`User not found for phone number: ${phoneNumber}`);
        return [];
      }

      // Then get all tasks for that user
      const { data, error } = await this.supabaseService.client
        .from('tasks')
        .select('*')
        .eq('user_id', userData.id)
        .order('scheduled_date', { ascending: true });

      if (error) {
        this.logger.error(`Error fetching tasks: ${error.message}`, error);
        throw new Error(`Failed to fetch tasks: ${error.message}`);
      }

      return data.map(this.mapDbTaskToEntity);
    } catch (error) {
      this.logger.error(`Error in findAllByPhone: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findAllByUser(userId: string): Promise<Task[]> {
    try {
      const { data, error } = await this.supabaseService.client
        .from('tasks')
        .select('*')
        .eq('user_id', userId)
        .order('scheduled_date', { ascending: true });

      if (error) {
        this.logger.error(`Error fetching tasks: ${error.message}`, error);
        throw new Error(`Failed to fetch tasks: ${error.message}`);
      }

      return data.map(this.mapDbTaskToEntity);
    } catch (error) {
      this.logger.error(`Error in findAllByUser: ${error.message}`, error.stack);
      throw error;
    }
  }

  async findOne(id: string): Promise<Task> {
    try {
      const { data, error } = await this.supabaseService.client
        .from('tasks')
        .select('*')
        .eq('id', id)
        .single();

      if (error) {
        this.logger.error(`Error fetching task: ${error.message}`, error);
        throw new NotFoundException(`Task with ID ${id} not found`);
      }

      return this.mapDbTaskToEntity(data);
    } catch (error) {
      this.logger.error(`Error in findOne: ${error.message}`, error.stack);
      throw error;
    }
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    try {
      const updateData: any = {};
      
      if (updateTaskDto.title) updateData.title = updateTaskDto.title;
      if (updateTaskDto.description) updateData.description = updateTaskDto.description;
      if (updateTaskDto.scheduledDate) updateData.scheduled_date = updateTaskDto.scheduledDate.toISOString();
      if (updateTaskDto.location) updateData.location = updateTaskDto.location;
      if (updateTaskDto.participants) updateData.participants = updateTaskDto.participants;
      if (updateTaskDto.status) updateData.status = updateTaskDto.status;
      
      const { data, error } = await this.supabaseService.client
        .from('tasks')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        this.logger.error(`Error updating task: ${error.message}`, error);
        throw new Error(`Failed to update task: ${error.message}`);
      }

      return this.mapDbTaskToEntity(data);
    } catch (error) {
      this.logger.error(`Error in update: ${error.message}`, error.stack);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      const { error } = await this.supabaseService.client
        .from('tasks')
        .delete()
        .eq('id', id);

      if (error) {
        this.logger.error(`Error deleting task: ${error.message}`, error);
        throw new Error(`Failed to delete task: ${error.message}`);
      }
    } catch (error) {
      this.logger.error(`Error in remove: ${error.message}`, error.stack);
      throw error;
    }
  }

  private mapDbTaskToEntity(data: any): Task {
    return {
      id: data.id,
      userId: data.user_id,
      title: data.title,
      description: data.description,
      scheduledDate: new Date(data.scheduled_date),
      location: data.location,
      participants: data.participants,
      status: data.status,
      createdAt: new Date(data.created_at),
    };
  }
}