import { Module, forwardRef } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksScheduler } from './tasks.scheduler';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    forwardRef(() => NotificationsModule),
  ],
  controllers: [TasksController],
  providers: [TasksService, TasksScheduler],
  exports: [TasksService],
})
export class TasksModule {}