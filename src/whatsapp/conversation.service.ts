// src/whatsapp/conversation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ConversationContext, ConversationState, TaskData } from './entities/conversation-state.entity';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  
  constructor(private readonly supabaseService: SupabaseService) {}

  async getConversationState(phoneNumber: string): Promise<ConversationContext | null> {
    try {
      const { data, error } = await this.supabaseService.client
        .from('conversation_states')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();
        
      if (error) {
        if (error.code === 'PGRST116') {
          // No state found, return null
          return null;
        }
        this.logger.error(`Error fetching conversation state: ${error.message}`, error);
        throw error;
      }
      
      return {
        state: data.state as ConversationState,
        taskData: data.task_data as TaskData,
        lastUpdateTime: new Date(data.last_update_time),
      };
    } catch (error) {
      this.logger.error(`Error in getConversationState: ${error.message}`, error.stack);
      return null;
    }
  }
  
  async saveConversationState(phoneNumber: string, context: ConversationContext): Promise<void> {
    try {
      // First check if the record exists
      const { data: existingData, error: checkError } = await this.supabaseService.client
        .from('conversation_states')
        .select('id')
        .eq('phone_number', phoneNumber)
        .maybeSingle();
        
      if (checkError) {
        this.logger.error(`Error checking for existing conversation: ${checkError.message}`, checkError);
        throw checkError;
      }

      // Prepare the data
      const now = new Date().toISOString();
      const saveData = {
        phone_number: phoneNumber,
        state: context.state,
        task_data: context.taskData,
        last_update_time: now,
      };
      
      let error;
      
      if (existingData) {
        // If exists, update it
        const { error: updateError } = await this.supabaseService.client
          .from('conversation_states')
          .update(saveData)
          .eq('phone_number', phoneNumber);
          
        error = updateError;
      } else {
        // If not exists, insert new record
        const { error: insertError } = await this.supabaseService.client
          .from('conversation_states')
          .insert([{
            ...saveData,
            created_at: now
          }]);
          
        error = insertError;
      }
        
      if (error) {
        this.logger.error(`Error saving conversation state: ${error.message}`, error);
        throw error;
      }
      
      this.logger.debug(`Successfully saved conversation state for ${phoneNumber}`);
    } catch (error) {
      this.logger.error(`Error in saveConversationState: ${error.message}`, error.stack);
      throw error;
    }
  }
  
  async clearConversationState(phoneNumber: string): Promise<void> {
    try {
      const { error } = await this.supabaseService.client
        .from('conversation_states')
        .delete()
        .eq('phone_number', phoneNumber);
        
      if (error) {
        this.logger.error(`Error clearing conversation state: ${error.message}`, error);
        throw error;
      }
      
      this.logger.debug(`Successfully cleared conversation state for ${phoneNumber}`);
    } catch (error) {
      this.logger.error(`Error in clearConversationState: ${error.message}`, error.stack);
      throw error;
    }
  }
  
  // Check if a conversation state is stale (older than 30 minutes)
  isConversationStale(context: ConversationContext): boolean {
    const thirtyMinutesAgo = new Date();
    thirtyMinutesAgo.setMinutes(thirtyMinutesAgo.getMinutes() - 30);
    
    return context.lastUpdateTime < thirtyMinutesAgo;
  }
  
  // Initialize a new conversation context
  createInitialContext(): ConversationContext {
    return {
      state: ConversationState.COLLECTING_INFO,
      taskData: {
        fullText: [],
      },
      lastUpdateTime: new Date(),
    };
  }
}