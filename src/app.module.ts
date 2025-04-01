import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { TasksModule } from './tasks/tasks.module';
import { OpenaiModule } from './openai/openai.module';
import { SupabaseModule } from './supabase/supabase.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env`,
    }),
    
    // Scheduled tasks
    ScheduleModule.forRoot(),
    
    // HTTP cli
    
    // Core modules
    SupabaseModule,
    
    // Feature modules
    OpenaiModule,
    TasksModule,
    NotificationsModule, // Import NotificationsModule before WhatsappModule
    WhatsappModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}