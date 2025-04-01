import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { SupabaseService } from '../supabase/supabase.service';

interface PushNotificationDto {
  userId: string;
  taskId: string;
  pushToken: string;
  title: string;
  body: string;
}

interface WhatsAppNotificationDto {
  userId: string;
  taskId: string;
  phoneNumber: string;
  message: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expo: Expo;
  private readonly whatsappPhoneNumberId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsappService: WhatsappService,
  ) {
    // Initialize Expo SDK
    this.expo = new Expo();
    
    // Get WhatsApp phone number ID
    this.whatsappPhoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
  }

  async sendPushNotification(dto: PushNotificationDto): Promise<void> {
    try {
      const { pushToken, title, body, userId, taskId } = dto;
      
      // Record the notification in the database
      await this.supabaseService.client
        .from('notifications')
        .insert([
          {
            user_id: userId,
            task_id: taskId,
            type: 'push',
            title,
            body,
            status: 'processing',
          },
        ]);
      
      // Validate Expo push token
      if (!Expo.isExpoPushToken(pushToken)) {
        this.logger.error('Invalid Expo push token', { pushToken });
        throw new Error('Invalid Expo push token');
      }

      // Create message
      const message: ExpoPushMessage = {
        to: pushToken,
        sound: 'default',
        title,
        body,
        data: { taskId },
      };

      // Send notification to Expo
      const chunks = this.expo.chunkPushNotifications([message]);
      
      for (const chunk of chunks) {
        try {
          const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
          this.logger.log('Push notification sent', { ticketChunk });
        } catch (error) {
          this.logger.error('Error sending push notification chunk', error);
          throw error;
        }
      }
      
      // Update notification status to sent
      await this.supabaseService.client
        .from('notifications')
        .update({ 
          status: 'sent',
          sent_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('task_id', taskId)
        .eq('type', 'push')
        .is('sent_at', null);
    } catch (error) {
      this.logger.error(`Error sending push notification: ${error.message}`, error.stack);
      throw error;
    }
  }

  async sendWhatsAppNotification(dto: WhatsAppNotificationDto): Promise<void> {
    try {
      const { phoneNumber, message, userId, taskId } = dto;
      
      // Record the notification in the database
      await this.supabaseService.client
        .from('notifications')
        .insert([
          {
            user_id: userId,
            task_id: taskId,
            type: 'whatsapp',
            body: message,
            status: 'processing',
          },
        ]);
      
      if (!this.whatsappPhoneNumberId) {
        throw new Error('WhatsApp phone number ID not configured');
      }

      // Send WhatsApp message
      await this.whatsappService.sendMessage(
        this.whatsappPhoneNumberId,
        phoneNumber,
        message
      );
      
      // Update notification status to sent
      await this.supabaseService.client
        .from('notifications')
        .update({ 
          status: 'sent',
          sent_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('task_id', taskId)
        .eq('type', 'whatsapp')
        .is('sent_at', null);
        
      this.logger.log('WhatsApp notification sent', { to: phoneNumber });
    } catch (error) {
      this.logger.error(`Error sending WhatsApp notification: ${error.message}`, error.stack);
      throw error;
    }
  }
}