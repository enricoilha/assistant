import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    Query,
    NotFoundException,
    BadRequestException,
    Logger,
  } from '@nestjs/common';
  import { TasksService } from './tasks.service';
  import { CreateTaskDto } from './dto/create-task.dto';
  import { UpdateTaskDto } from './dto/update-task.dto';
  import { SupabaseService } from '../supabase/supabase.service';
  import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
  
  @ApiTags('tasks')
  @Controller('api/tasks')
  export class TasksController {
    private readonly logger = new Logger(TasksController.name);
  
    constructor(
      private readonly tasksService: TasksService,
      private readonly supabaseService: SupabaseService,
    ) {}
  
    @Post()
    @ApiOperation({ summary: 'Create a new task' })
    async create(@Body() createTaskDto: CreateTaskDto) {
      try {
        return await this.tasksService.createTask(createTaskDto);
      } catch (error) {
        this.logger.error(`Error creating task: ${error.message}`, error.stack);
        throw error;
      }
    }
  
    @Get()
    @ApiOperation({ summary: 'Get all tasks for a user by phone number' })
    @ApiQuery({ name: 'phone', description: 'User phone number', required: true })
    @ApiResponse({ status: 200, description: 'Returns tasks for the user' })
    async findAll(@Query('phone') phoneNumber: string) {
      if (!phoneNumber) {
        throw new BadRequestException('Phone number is required');
      }
  
      try {
        const tasks = await this.tasksService.findAllByPhone(phoneNumber);
        return tasks;
      } catch (error) {
        this.logger.error(`Error fetching tasks: ${error.message}`, error.stack);
        throw error;
      }
    }
  
    @Get(':id')
    @ApiOperation({ summary: 'Get a task by ID' })
    @ApiParam({ name: 'id', description: 'Task ID' })
    @ApiResponse({ status: 200, description: 'Returns the task' })
    @ApiResponse({ status: 404, description: 'Task not found' })
    async findOne(@Param('id') id: string) {
      try {
        return await this.tasksService.findOne(id);
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw error;
        }
        this.logger.error(`Error fetching task: ${error.message}`, error.stack);
        throw error;
      }
    }
  
    @Patch(':id')
    @ApiOperation({ summary: 'Update a task' })
    @ApiParam({ name: 'id', description: 'Task ID' })
    @ApiResponse({ status: 200, description: 'Returns the updated task' })
    @ApiResponse({ status: 404, description: 'Task not found' })
    async update(@Param('id') id: string, @Body() updateTaskDto: UpdateTaskDto) {
      try {
        // First check if task exists
        await this.tasksService.findOne(id);
        
        return await this.tasksService.update(id, updateTaskDto);
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw error;
        }
        this.logger.error(`Error updating task: ${error.message}`, error.stack);
        throw error;
      }
    }
  
    @Delete(':id')
    @ApiOperation({ summary: 'Delete a task' })
    @ApiParam({ name: 'id', description: 'Task ID' })
    @ApiResponse({ status: 200, description: 'Task deleted successfully' })
    @ApiResponse({ status: 404, description: 'Task not found' })
    async remove(@Param('id') id: string) {
      try {
        // First check if task exists
        await this.tasksService.findOne(id);
        
        await this.tasksService.remove(id);
        return { success: true, message: 'Task deleted successfully' };
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw error;
        }
        this.logger.error(`Error deleting task: ${error.message}`, error.stack);
        throw error;
      }
    }
  }