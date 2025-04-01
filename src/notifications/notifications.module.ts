import { Module, forwardRef } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ConfigModule } from '@nestjs/config';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => WhatsappModule), // Use forwardRef for circular dependency
  ],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}