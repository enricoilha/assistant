import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { HttpModule } from '@nestjs/axios';
import { OpenaiModule } from '../openai/openai.module';
import { TasksModule } from '../tasks/tasks.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConversationService } from './conversation.service';

@Module({
  imports: [
    HttpModule,
    OpenaiModule,

    forwardRef(() => TasksModule),
    forwardRef(() => NotificationsModule)
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService, ConversationService],
  exports: [WhatsappService],
})
export class WhatsappModule {}