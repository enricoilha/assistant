import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class TasksScheduler {
  private readonly logger = new Logger(TasksScheduler.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notificationsService: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleScheduledNotifications() {
    this.logger.debug('Running scheduled task for notifications');
    
    try {
      // Find tasks that are coming up soon and need notifications
      const now = new Date();
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
      
      // Get pending tasks scheduled within the next hour
      const { data: upcomingTasks, error } = await this.supabaseService.client
        .from('tasks')
        .select(`
          id,
          user_id,
          title,
          scheduled_date,
          location,
          status
        `)
        .eq('status', 'pending')
        .gte('scheduled_date', now.toISOString())
        .lte('scheduled_date', oneHourFromNow.toISOString());
      
      if (error) {
        this.logger.error(`Error fetching upcoming tasks: ${error.message}`, error);
        return;
      }
      
      if (!upcomingTasks || upcomingTasks.length === 0) {
        this.logger.debug('No upcoming tasks requiring notifications');
        return;
      }
      
      this.logger.log(`Found ${upcomingTasks.length} upcoming tasks requiring notifications`);
      
      // Process each task
      for (const task of upcomingTasks) {
        // Get user notification settings
        const { data: settings } = await this.supabaseService.client
          .from('user_settings')
          .select('*')
          .eq('user_id', task.user_id)
          .single();
          
        // Get user phone number for WhatsApp
        const { data: user } = await this.supabaseService.client
          .from('users')
          .select('phone_number, push_token')
          .eq('id', task.user_id)
          .single();
        
        // Check if we already sent notifications for this task
        const { data: existingNotifications } = await this.supabaseService.client
          .from('notifications')
          .select('id')
          .eq('task_id', task.id)
          .eq('status', 'sent');
          
        if (existingNotifications && existingNotifications.length > 0) {
          this.logger.debug(`Notifications already sent for task ${task.id}`);
          continue;
        }
        
        // Prepare notification data
        const taskDate = new Date(task.scheduled_date);
        const minutesUntil = Math.floor((taskDate.getTime() - now.getTime()) / (1000 * 60));
        
        // Send WhatsApp notification if enabled
        if (settings?.whatsapp_notifications && user?.phone_number) {
          try {
            await this.notificationsService.sendWhatsAppNotification({
              userId: task.user_id,
              taskId: task.id,
              phoneNumber: user.phone_number,
              message: `⏰ *Lembrete*: Você tem "${task.title}" em ${minutesUntil} minutos.${
                task.location ? `\n📍 Local: ${task.location}` : ''
              }`,
            });
            
            this.logger.log(`WhatsApp notification sent for task ${task.id}`);
          } catch (error) {
            this.logger.error(`Error sending WhatsApp notification: ${error.message}`, error.stack);
          }
        }
        
        // Send push notification if enabled
        if (settings?.push_notifications && user?.push_token) {
          try {
            await this.notificationsService.sendPushNotification({
              userId: task.user_id,
              taskId: task.id,
              pushToken: user.push_token,
              title: 'Lembrete de Compromisso',
              body: `Você tem "${task.title}" em ${minutesUntil} minutos.`,
            });
            
            this.logger.log(`Push notification sent for task ${task.id}`);
          } catch (error) {
            this.logger.error(`Error sending push notification: ${error.message}`, error.stack);
          }
        }
        
        // Record notification as sent
        await this.supabaseService.client
          .from('notifications')
          .insert([
            {
              user_id: task.user_id,
              task_id: task.id,
              type: 'reminder',
              status: 'sent',
              sent_at: now.toISOString(),
            },
          ]);
      }
    } catch (error) {
      this.logger.error(`Error processing scheduled notifications: ${error.message}`, error.stack);
    }
  }
}