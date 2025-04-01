import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OpenaiService } from '../openai/openai.service';
import { TasksService } from '../tasks/tasks.service';
import { lastValueFrom } from 'rxjs';
import { SupabaseService } from '../supabase/supabase.service';
import { ConversationService } from './conversation.service';
import { ConversationState, TaskData } from './entities/conversation-state.entity';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly whatsappApiUrl: string;
  private readonly whatsappToken: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly openaiService: OpenaiService,
    @Inject(forwardRef(() => TasksService))
    private readonly tasksService: TasksService,
    private readonly supabaseService: SupabaseService,
    private readonly conversationService: ConversationService,
  ) {
    this.whatsappApiUrl = this.configService.get<string>('WHATSAPP_API_URL');
    this.whatsappToken = this.configService.get<string>('WHATSAPP_TOKEN');
  }

  async handleIncomingMessage(body: any): Promise<void> {
    try {
      // Extract relevant information from WhatsApp webhook payload
      const { entry } = body;
      
      if (!entry || entry.length === 0) {
        this.logger.warn('No entry data in the webhook payload');
        return;
      }
  
      for (const entryData of entry) {
        const { changes } = entryData;
        
        if (!changes || changes.length === 0) continue;
  
        for (const change of changes) {
          const { value } = change;
          
          if (!value || !value.messages || value.messages.length === 0) continue;
  
          for (const message of value.messages) {
            if (message.type !== 'text') continue;
  
            const phoneNumberId = value.metadata.phone_number_id;
            const from = message.from; // This is the user's phone number
            const messageText = message.text.body;
            
            // Get or create user by phone number
            const userId = await this.getOrCreateUserByPhone(from);
            
            if (!userId) {
              this.logger.error(`Failed to get or create user for phone: ${from}`);
              continue;
            }
            
            // Process the message as part of a conversation
            await this.processConversation(phoneNumberId, from, userId, messageText);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error handling incoming message: ${error.message}`, error.stack);
    }
  }

  async getOrCreateUserByPhone(phoneNumber: string): Promise<string | null> {
  try {
    // Try to find existing user with this phone number
    const { data: existingUser, error: findError } = await this.supabaseService.client
      .from('users')
      .select('id')
      .eq('phone_number', phoneNumber)
      .single();

    if (existingUser) {
      return existingUser.id;
    }

    // If user doesn't exist, create a new one
    // We use phone number as the primary identifier
    const { data: newUser, error: createError } = await this.supabaseService.client
      .from('users')
      .insert([
        {
          phone_number: phoneNumber,
          whatsapp_connected: true,
        }
      ])
      .select('id')
      .single();

    if (createError) {
      this.logger.error(`Error creating user: ${createError.message}`, createError);
      return null;
    }

    // Create default user settings
    await this.supabaseService.client
      .from('user_settings')
      .insert([
        {
          user_id: newUser.id,
        }
      ]);

    return newUser.id;
  } catch (error) {
    this.logger.error(`Error getting or creating user: ${error.message}`, error.stack);
    return null;
  }
}

  async processConversation(phoneNumberId: string, from: string, userId: string, messageText: string): Promise<void> {
    try {
      // Get current conversation state
      let context = await this.conversationService.getConversationState(from);
      
      // Check for exact command keywords first
      const lowerCaseMessage = messageText.toLowerCase().trim();
      
      // Handle cancel/restart commands explicitly
      if (lowerCaseMessage === 'cancelar' || lowerCaseMessage === 'cancel' || lowerCaseMessage === '/cancelar') {
        await this.handleCancelCommand(phoneNumberId, from);
        return;
      }
      
      if (lowerCaseMessage === 'reiniciar' || lowerCaseMessage === 'restart' || lowerCaseMessage === '/reiniciar') {
        await this.handleRestartCommand(phoneNumberId, from);
        return;
      }
      
      if (lowerCaseMessage === 'ajuda' || lowerCaseMessage === 'help' || lowerCaseMessage === '/ajuda') {
        await this.handleHelpCommand(phoneNumberId, from);
        return;
      }
      
      // Create new context if none exists or if the existing one is stale
      if (!context || (context && this.conversationService.isConversationStale(context))) {
        context = this.conversationService.createInitialContext();
      }
      
      // Process based on current state first
      if (context.state !== ConversationState.INITIAL) {
        // Update task fullText array with new message
        if (!context.taskData.fullText) {
          context.taskData.fullText = [];
        }
        context.taskData.fullText.push(messageText);
        
        const currentState = context.state as ConversationState;
        if (currentState === ConversationState.UPDATING_TASK) {
          // Continue updating the current task
          await this.handleTaskUpdate(phoneNumberId, from, userId, messageText, context);
          await this.conversationService.saveConversationState(from, context);
          return;
        }
        
        switch (currentState) {
          case ConversationState.COLLECTING_INFO:
  
          await this.handleCollectingInfo(phoneNumberId, from, userId, messageText, context, null);            
          await this.conversationService.saveConversationState(from, context);
            return;
            
          case ConversationState.CONFIRMING:
            await this.handleConfirmation(phoneNumberId, from, userId, messageText, context);
            await this.conversationService.saveConversationState(from, context);
            return;
            
          case ConversationState.SELECTING_TASK:
            await this.handleTaskSelection(phoneNumberId, from, userId, messageText, context);
            await this.conversationService.saveConversationState(from, context);
            return;
            
          case ConversationState.DELETING_TASK:
            await this.handleTaskDeletion(phoneNumberId, from, userId, messageText, context);
            await this.conversationService.saveConversationState(from, context);
            return;
        }
      }
      
      // If we're in the initial state or the state wasn't handled above, detect the intent
      const crudIntent = await this.openaiService.detectCrudIntent(messageText, context);
      
      // Process based on detected intent
      if (crudIntent.confidence > 0.6) { // Only act if confidence is reasonably high
        switch (crudIntent.operation) {
          case 'create':
            // Start or continue appointment creation
            context.taskData.fullText = context.taskData.fullText || [];
            context.taskData.fullText.push(messageText);
            context.state = ConversationState.COLLECTING_INFO;
            await this.handleCollectingInfo(phoneNumberId, from, userId, messageText, context, null);
            break;
            
          case 'read':
            // List appointments
            await this.handleListCommand(phoneNumberId, from, userId);
            context = this.conversationService.createInitialContext(); // Reset context after listing
            break;
            
          case 'update':
            if (crudIntent.taskId) {
              // Update a specific task by ID
              try {
                const task = await this.tasksService.findOne(crudIntent.taskId);
                if (task.userId === userId) {
                  await this.startTaskUpdate(phoneNumberId, from, userId, task);
                  // The context will be updated in startTaskUpdate
                  context = null; // To prevent saving the old context
                } else {
                  await this.sendMessage(
                    phoneNumberId,
                    from,
                    'Este compromisso não pertence a você ou não existe.'
                  );
                }
              } catch (error) {
                // Task ID not found, try to handle as natural language update
                await this.handleNaturalLanguageUpdate(phoneNumberId, from, userId, messageText, crudIntent);
              }
            } else {
              // Try to handle as natural language update
              await this.handleNaturalLanguageUpdate(phoneNumberId, from, userId, messageText, crudIntent);
            }
            break;
            
          case 'delete':
            if (crudIntent.taskId) {
              // Delete a specific task by ID
              try {
                const task = await this.tasksService.findOne(crudIntent.taskId);
                if (task.userId === userId) {
                  await this.startTaskDeletion(phoneNumberId, from, userId, task);
                  // The context will be updated in startTaskDeletion
                  context = null; // To prevent saving the old context
                } else {
                  await this.sendMessage(
                    phoneNumberId,
                    from,
                    'Este compromisso não pertence a você ou não existe.'
                  );
                }
              } catch (error) {
                // Task ID not found, handle natural language delete
                await this.handleNaturalLanguageDelete(phoneNumberId, from, userId, messageText);
              }
            } else {
              // Handle natural language delete
              await this.handleNaturalLanguageDelete(phoneNumberId, from, userId, messageText);
            }
            break;
            
          default:
            // If no clear intent is detected, default to treating it as appointment creation
            context.taskData.fullText = context.taskData.fullText || [];
            context.taskData.fullText.push(messageText);
            context.state = ConversationState.COLLECTING_INFO;
            await this.handleCollectingInfo(phoneNumberId, from, userId, messageText, context, null);
          }
      } else {
        // If confidence is low, default to treating it as appointment creation
        context.taskData.fullText = context.taskData.fullText || [];
        context.taskData.fullText.push(messageText);
        context.state = ConversationState.COLLECTING_INFO;
        await this.handleCollectingInfo(phoneNumberId, from, userId, messageText, context, null);
      }
      
      // Save updated context if not null
      if (context) {
        await this.conversationService.saveConversationState(from, context);
      }
      
    } catch (error) {
      this.logger.error(`Error processing conversation: ${error.message}`, error.stack);
      
      // Send error message
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente mais tarde.'
      );
    }
  }
  private async handleListCommand(phoneNumberId: string, from: string, userId: string): Promise<void> {
    try {
      // Get all tasks for the user
      const tasks = await this.tasksService.findAllByUser(userId);
      
      if (!tasks || tasks.length === 0) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Você não tem compromissos agendados. Para criar um novo compromisso, basta me dizer os detalhes.'
        );
        return;
      }
      
      // Group tasks by date
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const pastTasks = tasks.filter(task => new Date(task.scheduledDate) < today);
      const upcomingTasks = tasks.filter(task => new Date(task.scheduledDate) >= today);
      
      // Sort upcoming tasks by date
      upcomingTasks.sort((a, b) => 
        new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime()
      );
      
      // Generate list message
      let message = '*Seus compromissos*\n\n';
      
      if (upcomingTasks.length > 0) {
        message += '*Próximos compromissos:*\n';
        upcomingTasks.forEach((task, index) => {
          const date = new Date(task.scheduledDate);
          const formattedDate = date.toLocaleDateString('pt-BR', {
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            hour: '2-digit',
            minute: '2-digit'
          });
          
          message += `${index + 1}. *${task.title}* - ${formattedDate}`;
          if (task.location) {
            message += ` - ${task.location}`;
          }
          message += `\n   ID: ${task.id}\n\n`;
        });
      }
      
      if (pastTasks.length > 0) {
        message += '*Compromissos passados:*\n';
        // Show only the last 5 past tasks
        const recentPastTasks = pastTasks
          .sort((a, b) => 
            new Date(b.scheduledDate).getTime() - new Date(a.scheduledDate).getTime()
          )
          .slice(0, 5);
        
        recentPastTasks.forEach((task, index) => {
          const date = new Date(task.scheduledDate);
          const formattedDate = date.toLocaleDateString('pt-BR', {
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            hour: '2-digit',
            minute: '2-digit'
          });
          
          message += `${index + 1}. *${task.title}* - ${formattedDate}`;
          if (task.location) {
            message += ` - ${task.location}`;
          }
          message += `\n   ID: ${task.id}\n\n`;
        });
        
        if (pastTasks.length > 5) {
          message += `...e mais ${pastTasks.length - 5} compromissos passados.\n\n`;
        }
      }
      
      message += 'Para gerenciar seus compromissos, use:\n';
      message += '• "atualizar [ID]" - Editar um compromisso\n';
      message += '• "excluir [ID]" - Remover um compromisso\n';
      
      await this.sendMessage(phoneNumberId, from, message);
      
      // Create a new context with the list of tasks
      const context = this.conversationService.createInitialContext();
      context.state = ConversationState.INITIAL;
      context.tasks = tasks;
      
      await this.conversationService.saveConversationState(from, context);
      
    } catch (error) {
      this.logger.error(`Error handling list command: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao buscar seus compromissos. Tente novamente mais tarde.'
      );
    }
  }

  private async handleTaskDeletion(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    messageText: string, 
    context: any
  ): Promise<void> {
    try {
      const lowerCaseMessage = messageText.toLowerCase().trim();
      
      // Check user's response
      if (lowerCaseMessage === 'sim' || lowerCaseMessage === 'confirmar' || lowerCaseMessage === 'delete_confirm' || lowerCaseMessage === 'sim, excluir') {
        // Delete the task
        await this.deleteTask(phoneNumberId, from, context.selectedTaskId);
      } else {
        // Cancel deletion
        await this.sendMessage(
          phoneNumberId,
          from,
          'Exclusão cancelada. O compromisso não foi removido.'
        );
        
        // Clear conversation state
        await this.conversationService.clearConversationState(from);
      }
    } catch (error) {
      this.logger.error(`Error handling task deletion: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar a exclusão. Tente novamente mais tarde.'
      );
    }
  }

  private async handleTaskSelection(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    messageText: string, 
    context: any
  ): Promise<void> {
    try {
      const selection = parseInt(messageText.trim());
      
      // Validate selection
      if (isNaN(selection) || selection < 1 || selection > context.tasks.length) {
        await this.sendMessage(
          phoneNumberId,
          from,
          `Por favor, responda com um número entre 1 e ${context.tasks.length}.`
        );
        return;
      }
      
      // Get the selected task
      const selectedTask = context.tasks[selection - 1];
      
      if (context.operation === 'update') {
        // Start update process for the selected task
        await this.startTaskUpdate(phoneNumberId, from, userId, selectedTask);
      } else if (context.operation === 'delete') {
        // Start delete process for the selected task
        await this.startTaskDeletion(phoneNumberId, from, userId, selectedTask);
      }
      
    } catch (error) {
      this.logger.error(`Error handling task selection: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar sua seleção. Tente novamente mais tarde.'
      );
    }
  }

  private async startTaskDeletion(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    task: any
  ): Promise<void> {
    try {
      const date = new Date(task.scheduledDate);
      const formattedDate = date.toLocaleDateString('pt-BR', {
        weekday: 'long', 
        day: 'numeric', 
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      // Format task information
      let message = `*Você está prestes a excluir:*\n\n`
        + `📝 *${task.title}*\n`
        + `📅 ${formattedDate}`;
        
      if (task.location) {
        message += `\n📍 Local: ${task.location}`;
      }
      
      // Send interactive confirmation
      await this.sendInteractiveDeleteConfirmation(
        phoneNumberId,
        from,
        message,
        task.id
      );
      
      // Create delete context
      const context = this.conversationService.createInitialContext();
      context.state = ConversationState.DELETING_TASK;
      context.selectedTaskId = task.id;
      
      await this.conversationService.saveConversationState(from, context);
      
    } catch (error) {
      this.logger.error(`Error starting task deletion: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar a exclusão. Tente novamente mais tarde.'
      );
    }
  }

  private async sendInteractiveDeleteConfirmation(
    phoneNumberId: string, 
    to: string, 
    message: string,
    taskId: string
  ): Promise<void> {
    try {
      const url = `${this.whatsappApiUrl}/${phoneNumberId}/messages`;
      
      const data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: `${message}\n\nTem certeza que deseja excluir este compromisso?`
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'delete_confirm',
                  title: 'Sim, excluir'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'delete_cancel',
                  title: 'Cancelar'
                }
              }
            ]
          }
        }
      };
      
      const config = {
        headers: {
          'Authorization': `Bearer ${this.whatsappToken}`,
          'Content-Type': 'application/json',
        },
      };
      
      await lastValueFrom(this.httpService.post(url, data, config));
      this.logger.log(`Interactive delete confirmation sent to ${to}`);
    } catch (error) {
      this.logger.error(`Error sending interactive delete confirmation: ${error.message}`, error.stack);
      
      // Fallback to regular message if interactive fails
      await this.sendMessage(
        phoneNumberId,
        to,
        `${message}\n\nTem certeza que deseja excluir este compromisso? Responda com "sim" para confirmar ou "não" para cancelar.`
      );
    }
  }

  private async startTaskUpdate(
  phoneNumberId: string, 
  from: string, 
  userId: string, 
  task: any
): Promise<void> {
  try {
    const date = new Date(task.scheduledDate);
    const formattedDate = date.toLocaleDateString('pt-BR', {
      weekday: 'long', 
      day: 'numeric', 
      month: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    let message = `*Atualizando compromisso:*\n\n`
      + `📝 *${task.title}*\n`
      + `📅 ${formattedDate}`;
      
    if (task.location) {
      message += `\n📍 Local: ${task.location}`;
    }
    
    if (task.participants && task.participants.length > 0) {
      message += `\n👥 Participantes: ${task.participants.join(', ')}`;
    }
    
    message += `\n\nDigite as informações que deseja alterar (ex: "horário para 16h" ou "local: Shopping").\n`
      + `Quando terminar, digite "confirmar" para salvar as alterações.`;
    
    await this.sendMessage(phoneNumberId, from, message);
    
    // Create a new context for updating
    const context = this.conversationService.createInitialContext();
    context.state = ConversationState.UPDATING_TASK;
    context.taskData = {
      action: task.title,
      dateTime: new Date(task.scheduledDate),
      location: task.location,
      participants: task.participants,
      fullText: []
    };
    context.selectedTaskId = task.id;
    
    await this.conversationService.saveConversationState(from, context);
    
  } catch (error) {
    this.logger.error(`Error starting task update: ${error.message}`, error.stack);
    await this.sendMessage(
      phoneNumberId,
      from,
      'Ocorreu um erro ao iniciar a atualização. Tente novamente mais tarde.'
    );
  }
}
  private async handleTaskUpdate(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    messageText: string, 
    context: any
  ): Promise<void> {
    try {
      const lowerCaseMessage = messageText.toLowerCase().trim();
      
      // Check if user wants to finish updating
      if (lowerCaseMessage === 'confirmar' || lowerCaseMessage === 'salvar' || lowerCaseMessage === 'ok') {
        // Save the updates
        await this.updateTask(phoneNumberId, from, userId, context.selectedTaskId, context.taskData);
        return;
      }
      
      // Add message to the context
      context.taskData.fullText.push(messageText);
      
      // Get previous task info for comparison
      const previousTaskInfo = { ...context.taskData };
      
      // Extract updated information
      const fullText = context.taskData.fullText.join('\n');
      const updatedTaskInfo = await this.openaiService.extractTaskInformation(fullText);
      
      // Update task data with new information
      if (updatedTaskInfo) {
        if (updatedTaskInfo.action) context.taskData.action = updatedTaskInfo.action;
        if (updatedTaskInfo.dateTime) context.taskData.dateTime = updatedTaskInfo.dateTime;
        if (updatedTaskInfo.location) context.taskData.location = updatedTaskInfo.location;
        if (updatedTaskInfo.participants) context.taskData.participants = updatedTaskInfo.participants;
      }
      
      // Check for changes
      const hasChanges = this.checkForInfoChanges(previousTaskInfo, context.taskData);
      
      if (hasChanges) {
        // Show current information with changes highlighted
        const changeHighlights = this.getChangeHighlights(previousTaskInfo, context.taskData);
        const currentInfo = this.createConfirmationMessage(context.taskData);
        
        let message = `*Informações atualizadas:*\n\n${currentInfo}`;
        
        if (changeHighlights) {
          message += `\n\n*Alterações detectadas:*\n${changeHighlights}`;
        }
        
        message += `\n\nContinue digitando alterações ou digite "confirmar" para salvar.`;
        
        await this.sendMessage(phoneNumberId, from, message);
      } else {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Não detectei alterações claras. Tente ser mais específico (ex: "hora para 16h" ou "local: Shopping"). Digite "confirmar" quando terminar.'
        );
      }
      
    } catch (error) {
      this.logger.error(`Error handling task update: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar a atualização. Tente novamente mais tarde.'
      );
    }
  }
  
  private async updateTask(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    taskId: string, 
    taskData: any
  ): Promise<void> {
    try {
      // Update the task
      const updatedTask = await this.tasksService.update(taskId, {
        title: taskData.action,
        scheduledDate: taskData.dateTime,
        location: taskData.location,
        participants: taskData.participants
      });
      
      // Send confirmation
      const date = new Date(updatedTask.scheduledDate);
      const formattedDate = date.toLocaleDateString('pt-BR', {
        weekday: 'long', 
        day: 'numeric', 
        month: 'long',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      let message = `✅ *Compromisso atualizado com sucesso!*\n\n`
        + `📝 *${updatedTask.title}*\n`
        + `📅 ${formattedDate}`;
        
      if (updatedTask.location) {
        message += `\n📍 Local: ${updatedTask.location}`;
      }
      
      if (updatedTask.participants && updatedTask.participants.length > 0) {
        message += `\n👥 Participantes: ${updatedTask.participants.join(', ')}`;
      }
      
      await this.sendMessage(phoneNumberId, from, message);
      
      // Clear conversation state
      await this.conversationService.clearConversationState(from);
      
    } catch (error) {
      this.logger.error(`Error updating task: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao atualizar o compromisso. Tente novamente mais tarde.'
      );
    }
  }

  private async deleteTask(
    phoneNumberId: string, 
    from: string, 
    taskId: string
  ): Promise<void> {
    try {
      // Get task details before deleting (for confirmation message)
      const task = await this.tasksService.findOne(taskId);
      
      // Delete the task
      await this.tasksService.remove(taskId);
      
      // Send confirmation
      await this.sendMessage(
        phoneNumberId,
        from,
        `✅ Compromisso "*${task.title}*" foi excluído com sucesso!`
      );
      
      // Clear conversation state
      await this.conversationService.clearConversationState(from);
      
    } catch (error) {
      this.logger.error(`Error deleting task: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao excluir o compromisso. Tente novamente mais tarde.'
      );
    }
  }

  private async handleHelpCommand(phoneNumberId: string, from: string): Promise<void> {
    const helpMessage = `*Ajuda - Comandos Disponíveis*\n\n`
      + `• Para *criar* um compromisso, basta me dizer os detalhes (ex: "Reunião amanhã às 15h")\n\n`
      + `• *listar* - Mostra todos os seus compromissos\n\n`
      + `• *atualizar [ID]* - Atualiza um compromisso específico\n\n`
      + `• *excluir [ID]* - Remove um compromisso específico\n\n`
      + `• *cancelar* - Cancela a operação atual\n\n`
      + `• *reiniciar* - Recomeça a conversa\n\n`
      + `• *ajuda* - Mostra esta mensagem de ajuda\n\n`
      + `Para gerenciar seus compromissos, você pode usar o comando "listar" e depois selecionar qual compromisso deseja modificar ou excluir.`;
    
    await this.sendMessage(phoneNumberId, from, helpMessage);
  }

  private async handleNaturalLanguageUpdate(
    phoneNumberId: string,
    from: string,
    userId: string,
    messageText: string,
    crudIntent: any
  ): Promise<void> {
    try {
      // Get the most recent upcoming appointment if no specific one is mentioned
      const tasks = await this.tasksService.findAllByUser(userId);
      
      if (!tasks || tasks.length === 0) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Você não tem compromissos para atualizar. Para criar um novo compromisso, basta me dizer os detalhes.'
        );
        return;
      }
      
      // Filter for upcoming tasks and sort by date (closest first)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const upcomingTasks = tasks.filter(task => 
        new Date(task.scheduledDate) >= today
      ).sort((a, b) => 
        new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime()
      );
      
      if (upcomingTasks.length === 0) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Você não tem compromissos futuros para atualizar. Para criar um novo compromisso, basta me dizer os detalhes.'
        );
        return;
      }
      
      // Extract information from the update message
      let taskToUpdate = upcomingTasks[0]; // Default to the next upcoming task
      let updateInfo = crudIntent.updateInfo || {};
      
      // Try to match with existing appointments based on description
      if (messageText.toLowerCase().includes(taskToUpdate.title.toLowerCase())) {
        // Good, we have a match with the next upcoming task
      } else {
        // Check if the message mentions any other upcoming task
        for (const task of upcomingTasks) {
          if (messageText.toLowerCase().includes(task.title.toLowerCase())) {
            taskToUpdate = task;
            break;
          }
        }
      }
      
      // Extract task information from the message
      const extractedInfo = await this.openaiService.extractTaskInformation(messageText);
      if (extractedInfo) {
        updateInfo = { ...updateInfo, ...extractedInfo };
      }
      
      // If we have update information, start an update
      if (Object.keys(updateInfo).length > 0) {
        // Create context for updating this task
        const context = this.conversationService.createInitialContext();
        context.state = ConversationState.UPDATING_TASK;
        context.taskData = {
          action: updateInfo.action || taskToUpdate.title,
          dateTime: updateInfo.dateTime || new Date(taskToUpdate.scheduledDate),
          location: updateInfo.location || taskToUpdate.location,
          participants: updateInfo.participants || taskToUpdate.participants,
          fullText: [messageText]
        };
        context.selectedTaskId = taskToUpdate.id;
        
        // Check for changes
        const hasChanges = this.checkForInfoChanges({
          action: taskToUpdate.title,
          dateTime: new Date(taskToUpdate.scheduledDate),
          location: taskToUpdate.location,
          participants: taskToUpdate.participants
        }, context.taskData);
        
        if (hasChanges) {
          // Show what's being updated
          const date = new Date(taskToUpdate.scheduledDate);
          const formattedDate = date.toLocaleDateString('pt-BR', {
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            hour: '2-digit',
            minute: '2-digit'
          });
          
          // Get change highlights
          const changeHighlights = this.getChangeHighlights({
            action: taskToUpdate.title,
            dateTime: new Date(taskToUpdate.scheduledDate),
            location: taskToUpdate.location,
            participants: taskToUpdate.participants
          }, context.taskData);
          
          // Create message with original appointment and changes
          let message = `*Atualizando compromisso:*\n\n`
            + `📝 *${taskToUpdate.title}*\n`
            + `📅 ${formattedDate}`;
            
          if (taskToUpdate.location) {
            message += `\n📍 Local: ${taskToUpdate.location}`;
          }
          
          if (taskToUpdate.participants && taskToUpdate.participants.length > 0) {
            message += `\n👥 Participantes: ${taskToUpdate.participants.join(', ')}`;
          }
          
          if (changeHighlights) {
            message += `\n\n*Alterações detectadas:*\n${changeHighlights}`;
          }
          
          message += `\n\nConfirma estas alterações?`;
          
          // Send interactive confirmation
          await this.sendInteractiveConfirmation(
            phoneNumberId,
            from,
            message
          );
          
          // Save the context
          await this.conversationService.saveConversationState(from, context);
        } else {
          await this.sendMessage(
            phoneNumberId,
            from,
            'Não detectei alterações específicas. Por favor, indique claramente o que deseja alterar (ex: "horário para 16h" ou "local: Shopping").'
          );
        }
      } else {
        // If we don't have enough info, ask user to select from list
        await this.handleUpdateCommand(phoneNumberId, from, userId, 'atualizar');
      }
    } catch (error) {
      this.logger.error(`Error handling natural language update: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar sua atualização. Tente novamente ou use o comando "atualizar" para ver a lista de compromissos.'
      );
    }
  }

  private async handleUpdateCommand(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    messageText: string
  ): Promise<void> {
    try {
      // Extract the task ID from the message
      const idMatch = messageText.match(/atualizar\s+(\S+)|editar\s+(\S+)|\/atualizar\s+(\S+)/i);
      let taskId = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3]) : null;
      
      if (!taskId) {
        // If no ID is provided, ask user to choose from a list
        const tasks = await this.tasksService.findAllByUser(userId);
        
        if (!tasks || tasks.length === 0) {
          await this.sendMessage(
            phoneNumberId,
            from,
            'Você não tem compromissos para atualizar. Para criar um novo compromisso, basta me dizer os detalhes.'
          );
          return;
        }
        
        // Filter for upcoming tasks only
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const upcomingTasks = tasks.filter(task => 
          new Date(task.scheduledDate) >= today
        ).sort((a, b) => 
          new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime()
        );
        
        if (upcomingTasks.length === 0) {
          await this.sendMessage(
            phoneNumberId,
            from,
            'Você não tem compromissos futuros para atualizar. Para criar um novo compromisso, basta me dizer os detalhes.'
          );
          return;
        }
        
        // Create selection list
        let message = '*Selecione o compromisso para atualizar:*\n\n';
        
        upcomingTasks.forEach((task, index) => {
          const date = new Date(task.scheduledDate);
          const formattedDate = date.toLocaleDateString('pt-BR', {
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            hour: '2-digit',
            minute: '2-digit'
          });
          
          message += `${index + 1}. *${task.title}* - ${formattedDate}`;
          if (task.location) {
            message += ` - ${task.location}`;
          }
          message += '\n';
        });
        
        message += '\nResponda com o número do compromisso que deseja atualizar.';
        
        // Send selection list
        await this.sendMessage(phoneNumberId, from, message);
        
        // Create a context for task selection
        const context = this.conversationService.createInitialContext();
        context.state = ConversationState.SELECTING_TASK;
        context.operation = 'update';
        context.tasks = upcomingTasks;
        
        await this.conversationService.saveConversationState(from, context);
        return;
      }
      
      // If ID is provided, verify it exists and belongs to the user
      try {
        const task = await this.tasksService.findOne(taskId);
        
        if (task.userId !== userId) {
          await this.sendMessage(
            phoneNumberId,
            from,
            'Este compromisso não pertence a você ou não existe. Verifique o ID e tente novamente.'
          );
          return;
        }
        
        // Start update process
        await this.startTaskUpdate(phoneNumberId, from, userId, task);
        
      } catch (error) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Não foi possível encontrar um compromisso com este ID. Verifique o ID e tente novamente, ou use o comando "listar" para ver seus compromissos.'
        );
      }
      
    } catch (error) {
      this.logger.error(`Error handling update command: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar sua solicitação. Tente novamente mais tarde.'
      );
    }
  }

  private async handleNaturalLanguageDelete(
    phoneNumberId: string,
    from: string,
    userId: string,
    messageText: string
  ): Promise<void> {
    try {
      // Get all tasks for the user
      const tasks = await this.tasksService.findAllByUser(userId);
      
      if (!tasks || tasks.length === 0) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Você não tem compromissos para excluir. Para criar um novo compromisso, basta me dizer os detalhes.'
        );
        return;
      }
      
      // Filter for upcoming tasks
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const upcomingTasks = tasks.filter(task => 
        new Date(task.scheduledDate) >= today
      ).sort((a, b) => 
        new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime()
      );
      
      if (upcomingTasks.length === 0) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Você não tem compromissos futuros para excluir. Para criar um novo compromisso, basta me dizer os detalhes.'
        );
        return;
      }
      
      // Try to match the message with a specific task
      let taskToDelete = null;
      const lowerCaseMessage = messageText.toLowerCase();
      
      for (const task of upcomingTasks) {
        // Check if the message mentions this specific task
        if (lowerCaseMessage.includes(task.title.toLowerCase())) {
          taskToDelete = task;
          break;
        }
        
        // Check for date/time references
        const taskDate = new Date(task.scheduledDate);
        const taskDateStr = taskDate.toLocaleDateString('pt-BR');
        const taskTimeStr = taskDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        
        if (lowerCaseMessage.includes(taskDateStr) || lowerCaseMessage.includes(taskTimeStr)) {
          taskToDelete = task;
          break;
        }
      }
      
      if (taskToDelete) {
        // Found a matching task, start deletion
        await this.startTaskDeletion(phoneNumberId, from, userId, taskToDelete);
      } else {
        // No specific task found, show the delete selection list
        await this.handleDeleteCommand(phoneNumberId, from, userId, 'excluir');
      }
    } catch (error) {
      this.logger.error(`Error handling natural language delete: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar sua solicitação. Tente novamente ou use o comando "excluir" para ver a lista de compromissos.'
      );
    }
  }
  
  private async handleDeleteCommand(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    messageText: string
  ): Promise<void> {
    try {
      // Extract the task ID from the message
      const idMatch = messageText.match(/excluir\s+(\S+)|deletar\s+(\S+)|\/excluir\s+(\S+)/i);
      let taskId = idMatch ? (idMatch[1] || idMatch[2] || idMatch[3]) : null;
      
      if (!taskId) {
        // If no ID is provided, ask user to choose from a list
        const tasks = await this.tasksService.findAllByUser(userId);
        
        if (!tasks || tasks.length === 0) {
          await this.sendMessage(
            phoneNumberId,
            from,
            'Você não tem compromissos para excluir. Para criar um novo compromisso, basta me dizer os detalhes.'
          );
          return;
        }
        
        // Filter for upcoming tasks only
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const upcomingTasks = tasks.filter(task => 
          new Date(task.scheduledDate) >= today
        ).sort((a, b) => 
          new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime()
        );
        
        if (upcomingTasks.length === 0) {
          await this.sendMessage(
            phoneNumberId,
            from,
            'Você não tem compromissos futuros para excluir. Para criar um novo compromisso, basta me dizer os detalhes.'
          );
          return;
        }
        
        // Create selection list
        let message = '*Selecione o compromisso para excluir:*\n\n';
        
        upcomingTasks.forEach((task, index) => {
          const date = new Date(task.scheduledDate);
          const formattedDate = date.toLocaleDateString('pt-BR', {
            weekday: 'long', 
            day: 'numeric', 
            month: 'long',
            hour: '2-digit',
            minute: '2-digit'
          });
          
          message += `${index + 1}. *${task.title}* - ${formattedDate}`;
          if (task.location) {
            message += ` - ${task.location}`;
          }
          message += '\n';
        });
        
        message += '\nResponda com o número do compromisso que deseja excluir.';
        
        // Send selection list
        await this.sendMessage(phoneNumberId, from, message);
        
        // Create a context for task selection
        const context = this.conversationService.createInitialContext();
        context.state = ConversationState.SELECTING_TASK;
        context.operation = 'delete';
        context.tasks = upcomingTasks;
        
        await this.conversationService.saveConversationState(from, context);
        return;
      }
      
      // If ID is provided, verify it exists and belongs to the user
      try {
        const task = await this.tasksService.findOne(taskId);
        
        if (task.userId !== userId) {
          await this.sendMessage(
            phoneNumberId,
            from,
            'Este compromisso não pertence a você ou não existe. Verifique o ID e tente novamente.'
          );
          return;
        }
        
        // Start delete process
        await this.startTaskDeletion(phoneNumberId, from, userId, task);
        
      } catch (error) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Não foi possível encontrar um compromisso com este ID. Verifique o ID e tente novamente, ou use o comando "listar" para ver seus compromissos.'
        );
      }
      
    } catch (error) {
      this.logger.error(`Error handling delete command: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar sua solicitação. Tente novamente mais tarde.'
      );
    }
  }
  
  private async handleCollectingInfo(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    messageText: string, 
    context: any,
    previousTaskInfo: TaskData | null
  ): Promise<void> {
    try {
      // Add message to the context
      context.taskData.fullText.push(messageText);
      
      // Try to extract information
      const fullText = context.taskData.fullText.join('\n');
      const updatedTaskInfo = await this.openaiService.extractTaskInformation(fullText);
      
      // Update context with extracted information
      if (updatedTaskInfo) {
        this.logger.debug('Extracted task info:', updatedTaskInfo);
        if (updatedTaskInfo.action) context.taskData.action = updatedTaskInfo.action;
        if (updatedTaskInfo.dateTime) context.taskData.dateTime = updatedTaskInfo.dateTime;
        if (updatedTaskInfo.location) context.taskData.location = updatedTaskInfo.location;
        if (updatedTaskInfo.participants) context.taskData.participants = updatedTaskInfo.participants;
      } else {
        this.logger.warn('Failed to extract task information from message:', messageText);
        
        // Direct extraction for common patterns if OpenAI failed
        if (messageText.toLowerCase().includes('almoço') && !context.taskData.action) {
          context.taskData.action = 'Almoço';
        }
        
        const timePattern = /(\d{1,2})[:\.](\d{2})/;
        const match = messageText.match(timePattern);
        if (match && !context.taskData.dateTime) {
          const hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const today = new Date();
          today.setHours(hours, minutes, 0, 0);
          context.taskData.dateTime = today;
        }
        
        if (messageText.toLowerCase().includes('restaurante') && !context.taskData.location) {
          const restaurantMatch = messageText.match(/restaurante\s+(\w+)/i);
          if (restaurantMatch) {
            context.taskData.location = `Restaurante ${restaurantMatch[1]}`;
          }
        }
      }
      
      // Check if we have enough information to create a task
      if (context.taskData.action && context.taskData.dateTime) {
        // Proceed with confirmation
        const hasChanges = this.checkForInfoChanges(previousTaskInfo, context.taskData);
        
        if (hasChanges && previousTaskInfo) {
          const changeHighlights = this.getChangeHighlights(previousTaskInfo, context.taskData);
          const changeMessage = changeHighlights ? `\n\n*Alterações detectadas:*\n${changeHighlights}` : '';
          
          const confirmationMessage = this.createConfirmationMessage(context.taskData) + changeMessage;
          
          context.state = ConversationState.CONFIRMING;
          
          await this.sendInteractiveConfirmation(
            phoneNumberId, 
            from, 
            confirmationMessage
          );
        } else {
          context.state = ConversationState.CONFIRMING;
          
          await this.sendInteractiveConfirmation(
            phoneNumberId, 
            from, 
            this.createConfirmationMessage(context.taskData)
          );
        }
      } else {
        let responseMessage = 'Estou coletando informações para seu compromisso. ';
        
        if (!context.taskData.action) {
          responseMessage += 'Qual é o compromisso? ';
        }
        
        if (!context.taskData.dateTime) {
          responseMessage += 'Qual a data e hora? ';
        }
        
        await this.sendMessage(phoneNumberId, from, responseMessage);
      }
    } catch (error) {
      this.logger.error(`Error in handleCollectingInfo: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao processar sua mensagem. Por favor, tente novamente.'
      );
    }
  }

  
  private async handleConfirmation(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    messageText: string, 
    context: any
  ): Promise<void> {
    const response = messageText.toLowerCase();
    
    if (response.includes('sim') || response === 's' || response === 'yes' || response === 'confirmar') {
      await this.createTask(phoneNumberId, from, userId, context.taskData);
      
      await this.conversationService.clearConversationState(from);
    } else if (response.includes('não') || response.includes('nao') || response === 'n' || response === 'no' || response === 'editar') {
      context.state = ConversationState.COLLECTING_INFO;
      
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Entendi que você quer fazer alterações. Por favor, me diga o que precisa corrigir no agendamento.'
      );
    } else {
      context.state = ConversationState.COLLECTING_INFO;
      
      const newInfo = await this.openaiService.extractTaskInformation(messageText);
      if (newInfo) {
        if (newInfo.action) context.taskData.action = newInfo.action;
        if (newInfo.dateTime) context.taskData.dateTime = newInfo.dateTime;
        if (newInfo.location) context.taskData.location = newInfo.location;
        if (newInfo.participants) context.taskData.participants = newInfo.participants;
      }
      
      await this.handleCollectingInfo(phoneNumberId, from, userId, messageText, context, null);
    }
  }
  
  private async handleCancelCommand(phoneNumberId: string, from: string): Promise<void> {
    try {
      // Clear conversation state
      await this.conversationService.clearConversationState(from);
      
      // Send cancellation message
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Operação cancelada. Você pode começar novamente quando quiser. Digite qualquer mensagem para iniciar um novo agendamento.'
      );
    } catch (error) {
      this.logger.error(`Error handling cancel command: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async handleRestartCommand(phoneNumberId: string, from: string): Promise<void> {
    try {
      // Create a new initial context
      const newContext = this.conversationService.createInitialContext();
      
      // Save the new context
      await this.conversationService.saveConversationState(from, newContext);
      
      // Send restart message
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Conversa reiniciada. Vamos começar de novo! Por favor, me diga detalhes do seu compromisso (tipo, data, hora, local).'
      );
    } catch (error) {
      this.logger.error(`Error handling restart command: ${error.message}`, error.stack);
      throw error;
    }
  }

  private checkForInfoChanges(previous: TaskData | null, current: TaskData): boolean {
    if (!previous) return false;
    
    const actionChanged = previous.action !== current.action;
    
    let dateTimeChanged = false;
    if (previous.dateTime && current.dateTime) {
      if (previous.dateTime instanceof Date && current.dateTime instanceof Date) {
        dateTimeChanged = previous.dateTime.getTime() !== current.dateTime.getTime();
      } else {
        const prevDate = new Date(previous.dateTime).getTime();
        const currDate = new Date(current.dateTime).getTime();
        dateTimeChanged = !isNaN(prevDate) && !isNaN(currDate) && prevDate !== currDate;
      }
    } else {
      dateTimeChanged = (!!previous.dateTime) !== (!!current.dateTime);
    }
  
    const locationChanged = previous.location !== current.location;
    
    const participantsChanged = JSON.stringify(previous.participants) !== JSON.stringify(current.participants);
    
    return actionChanged || dateTimeChanged || locationChanged || participantsChanged;
  }

  private getChangeHighlights(previous: TaskData | null, current: TaskData): string | null {
    if (!previous) return null;
    
    const changes = [];
    
    if (previous.action !== current.action) {
      changes.push(`- Compromisso: "${previous.action || 'Não definido'}" → "${current.action}"`);
    }
    
    let dateTimeChanged = false;
    let prevDateFormatted = 'Não definida';
    let currDateFormatted = 'Não definida';
    
    if (previous.dateTime || current.dateTime) {
      try {
        if (previous.dateTime) {
          const prevDate = new Date(previous.dateTime);
          if (!isNaN(prevDate.getTime())) {
            prevDateFormatted = prevDate.toLocaleString('pt-BR', { 
              dateStyle: 'short', 
              timeStyle: 'short' 
            });
          }
        }
        
        if (current.dateTime) {
          const currDate = new Date(current.dateTime);
          if (!isNaN(currDate.getTime())) {
            currDateFormatted = currDate.toLocaleString('pt-BR', { 
              dateStyle: 'short', 
              timeStyle: 'short' 
            });
          }
        }
        
        // Compare the formatted date strings to detect changes
        dateTimeChanged = prevDateFormatted !== currDateFormatted;
        
        if (dateTimeChanged) {
          changes.push(`- Data/Hora: ${prevDateFormatted} → ${currDateFormatted}`);
        }
      } catch (error) {
        this.logger.error(`Error formatting dates for comparison: ${error.message}`);
        // If there's an error in date formatting, still add a generic change notification
        changes.push(`- Data/Hora: Atualizada`);
      }
    }
    
    if (previous.location !== current.location) {
      changes.push(`- Local: "${previous.location || 'Não definido'}" → "${current.location || 'Não definido'}"`);
    }
    
    if (JSON.stringify(previous.participants) !== JSON.stringify(current.participants)) {
      const prevPart = previous.participants?.length ? previous.participants.join(', ') : 'Ninguém';
      const currPart = current.participants?.length ? current.participants.join(', ') : 'Ninguém';
      changes.push(`- Participantes: ${prevPart} → ${currPart}`);
    }
    
    return changes.length > 0 ? changes.join('\n') : null;
  }

  private async sendInteractiveConfirmation(
    phoneNumberId: string, 
    to: string, 
    message: string
  ): Promise<void> {
    try {
      const url = `${this.whatsappApiUrl}/${phoneNumberId}/messages`;
      
      const data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: `${message}\n\nEstas informações estão corretas?`
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'confirm_yes',
                  title: 'Confirmar'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'confirm_no',
                  title: 'Editar'
                }
              }
            ]
          }
        }
      };
      
      const config = {
        headers: {
          'Authorization': `Bearer ${this.whatsappToken}`,
          'Content-Type': 'application/json',
        },
      };
      
      await lastValueFrom(this.httpService.post(url, data, config));
      this.logger.log(`Interactive message sent to ${to}`);
    } catch (error) {
      this.logger.error(`Error sending interactive message: ${error.message}`, error.stack);
      
      // Fallback to regular message if interactive fails
      await this.sendMessage(
        phoneNumberId,
        to,
        `${message}\n\nEstas informações estão corretas? Responda com "sim" para confirmar ou "não" para editar.`
      );
    }
  }
  
  private async createTask(
    phoneNumberId: string, 
    from: string, 
    userId: string, 
    taskData: TaskData
  ): Promise<void> {
    try {
      // Create the task
      const task = await this.tasksService.createTask({
        userId: userId,
        title: taskData.action,
        description: taskData.fullText?.join('\n'),
        scheduledDate: taskData.dateTime,
        location: taskData.location,
        participants: taskData.participants,
      });

      // Send confirmation message
      const confirmationMessage = this.createConfirmationMessage(taskData);
      await this.sendMessage(
        phoneNumberId, 
        from, 
        `✅ Compromisso agendado com sucesso!\n\n${confirmationMessage}`
      );
    } catch (error) {
      this.logger.error(`Error creating task: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Desculpe, ocorreu um erro ao criar seu compromisso. Tente novamente mais tarde.'
      );
    }
  }

  private createConfirmationMessage(taskInfo: any): string {
    const date = new Date(taskInfo.dateTime);
    const formattedDate = date.toLocaleDateString('pt-BR', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });

    let message = `📝 *${taskInfo.action}*\n📅 ${formattedDate}`;
    
    if (taskInfo.location) {
      message += `\n📍 Local: ${taskInfo.location}`;
    }
    
    if (taskInfo.participants && taskInfo.participants.length > 0) {
      message += `\n👥 Participantes: ${taskInfo.participants.join(', ')}`;
    }
    
    return message;
  }

  async sendMessage(phoneNumberId: string, to: string, message: string): Promise<void> {
    try {
      const url = `${this.whatsappApiUrl}/${phoneNumberId}/messages`;
      
      const data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: {
          body: message,
        },
      };
      
      const config = {
        headers: {
          'Authorization': `Bearer ${this.whatsappToken}`,
          'Content-Type': 'application/json',
        },
      };
      
      await lastValueFrom(this.httpService.post(url, data, config));
      this.logger.log(`Message sent to ${to}`);
    } catch (error) {
      this.logger.error(`Error sending WhatsApp message: ${error.message}`, error.stack);
      throw error;
    }
  }

  // For handling WhatsApp verification request
  verifyWebhook(mode: string, token: string, challenge: string): string {
    this.logger.log(`Received webhook verification request: mode=${mode}, token=${token}`);
    
    const verifyToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');
    
    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verified successfully');
      return challenge;
    }
    
    this.logger.warn('Webhook verification failed');
    throw new Error('Invalid verification token');
  }
  
}