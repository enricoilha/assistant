import { 
  Controller, 
  Post, 
  Body, 
  Get, 
  Query, 
  HttpCode, 
  Logger,
  HttpException,
  HttpStatus
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('webhook')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly whatsappService: WhatsappService) {}

  @Get()
  @HttpCode(200)
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    try {
      return this.whatsappService.verifyWebhook(mode, token, challenge);
    } catch (error) {
      this.logger.error(`Webhook verification failed: ${error.message}`);
      throw new HttpException('Invalid verification token', HttpStatus.FORBIDDEN);
    }
  }

  @Post()
  @HttpCode(200)
  async receiveMessage(@Body() body: any): Promise<{ status: string }> {
    this.logger.log('Received webhook event');
    this.logger.log('Object:', body);
    
    // Check if this is a message event or a status update
    if (this.isMessageEvent(body)) {
      await this.whatsappService.handleIncomingMessage(body);
    } else if (this.isInteractiveButtonEvent(body)) {
      await this.handleInteractiveButtonResponse(body);
    } else {
      this.logger.debug('Ignoring non-message event (status update)');
    }
    
    return { status: 'received' };
  }

  private isMessageEvent(body: any): boolean {
    try {
      // Check if the webhook contains actual text messages
      return body.entry?.some(entry => 
        entry.changes?.some(change => 
          change.value?.messages?.some(message => message.type === 'text')
        )
      ) || false;
    } catch (error) {
      this.logger.error(`Error checking message type: ${error.message}`);
      return false;
    }
  }
  
  private isInteractiveButtonEvent(body: any): boolean {
    try {
      // Check if the webhook contains interactive button responses
      return body.entry?.some(entry => 
        entry.changes?.some(change => 
          change.value?.messages?.some(message => message.type === 'interactive' && message.interactive?.type === 'button_reply')
        )
      ) || false;
    } catch (error) {
      this.logger.error(`Error checking interactive button event: ${error.message}`);
      return false;
    }
  }
  
  private async handleInteractiveButtonResponse(body: any): Promise<void> {
    try {
      // Extract the button response information
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (!change.value?.messages) continue;
          
          for (const message of change.value.messages) {
            if (message.type !== 'interactive' || message.interactive?.type !== 'button_reply') continue;
            
            const phoneNumberId = change.value.metadata.phone_number_id;
            const from = message.from;
            const buttonId = message.interactive.button_reply.id;
            const buttonTitle = message.interactive.button_reply.title;
            
            this.logger.log(`Received button response: ${buttonId} - ${buttonTitle} from ${from}`);
            
            // Map button IDs to text responses
            let messageText;
            if (buttonId === 'confirm_yes') {
              messageText = 'confirmar';
            } else if (buttonId === 'confirm_no') {
              messageText = 'editar';
            } else {
              messageText = buttonTitle.toLowerCase();
            }
            
            // Process the button response as a regular message
            const userId = await this.whatsappService.getOrCreateUserByPhone(from);
            if (userId) {
              await this.whatsappService.processConversation(phoneNumberId, from, userId, messageText);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error handling interactive button response: ${error.message}`, error.stack);
    }
  }
}