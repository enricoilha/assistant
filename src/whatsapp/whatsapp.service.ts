import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OpenaiService } from '../openai/openai.service';
import { TasksService } from '../tasks/tasks.service';
import { lastValueFrom } from 'rxjs';
import { SupabaseService } from '../supabase/supabase.service';
import { ConversationService } from './conversation.service';
import { ConversationState, TaskData } from './entities/conversation-state.entity';

/**
 * Armazena histórico de conversa recente para cada usuário
 */
interface ConversationHistory {
  messages: {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }[];
  lastTaskDiscussed?: {
    id: string;
    title: string;
    lastMentioned: Date;
  };
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly whatsappApiUrl: string;
  private readonly whatsappToken: string;
  
  // Mapa para armazenar histórico de conversa em memória
  private conversationHistories: Map<string, ConversationHistory> = new Map();

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
      // Verificar comandos especiais primeiro
      const lowerCaseMessage = messageText.toLowerCase().trim();
      
      // Comandos de sistema que ainda mantemos para simplicidade
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
      
      if (lowerCaseMessage === 'listar' || lowerCaseMessage === 'compromissos' || lowerCaseMessage === '/listar') {
        await this.handleListCommand(phoneNumberId, from, userId);
        return;
      }
      
      // Para todos os outros casos, usamos a abordagem conversacional inteligente
      await this.processMessageIntelligently(phoneNumberId, from, userId, messageText);
      
    } catch (error) {
      this.logger.error(`Erro no processamento da conversa: ${error.message}`, error.stack);
      
      // Mensagem de erro genérica
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente mais tarde.'
      );
    }
  }

  /**
   * Obtém o histórico de conversa recente
   */
  async getConversationHistory(phoneNumber: string): Promise<ConversationHistory> {
    // Verificar se já temos o histórico
    if (!this.conversationHistories.has(phoneNumber)) {
      // Inicializar histórico vazio
      this.conversationHistories.set(phoneNumber, {
        messages: []
      });
      
      // Em uma implementação mais robusta, recuperaríamos o histórico do banco de dados
    }
    
    return this.conversationHistories.get(phoneNumber);
  }

  /**
   * Adiciona uma mensagem ao histórico
   */
  async addToConversationHistory(
    phoneNumber: string, 
    role: 'user' | 'assistant', 
    content: string
  ): Promise<void> {
    const history = await this.getConversationHistory(phoneNumber);
    
    history.messages.push({
      role,
      content,
      timestamp: new Date()
    });
    
    // Manter apenas as últimas 10 mensagens para contexto
    if (history.messages.length > 10) {
      history.messages = history.messages.slice(-10);
    }
    
    // Em uma implementação mais robusta, salvaríamos no banco de dados
  }

  /**
   * Atualiza o último compromisso discutido
   */
  async updateLastDiscussedTask(
    phoneNumber: string,
    taskId: string,
    taskTitle: string
  ): Promise<void> {
    const history = await this.getConversationHistory(phoneNumber);
    
    history.lastTaskDiscussed = {
      id: taskId,
      title: taskTitle,
      lastMentioned: new Date()
    };
    
    // Em uma implementação mais robusta, salvaríamos no banco de dados
  }

  /**
   * Processa uma nova mensagem do usuário de forma inteligente
   */
  async processMessageIntelligently(
    phoneNumberId: string,
    from: string,
    userId: string,
    messageText: string
  ): Promise<void> {
    try {
      // Adicionar mensagem do usuário ao histórico
      await this.addToConversationHistory(from, 'user', messageText);
      
      // Obter histórico recente
      const history = await this.getConversationHistory(from);
      const conversationMessages = history.messages.map(m => `${m.role}: ${m.content}`);
      
      // Obter compromissos do usuário
      const userTasks = await this.tasksService.findAllByUser(userId);
      
      // Analisar a mensagem no contexto da conversa
      const analysis = await this.openaiService.analyzeConversation(
        messageText,
        conversationMessages,
        userTasks
      );
      
      // Processar a intenção detectada
      let responseText = '';
      
      switch (analysis.intent) {
        case 'update':
          responseText = await this.handleTaskUpdate(userId, analysis, userTasks);
          break;
          
        case 'create':
          responseText = await this.handleTaskCreation(userId, analysis);
          break;
          
        case 'delete':
          responseText = await this.handleTaskDeletion(userId, analysis, userTasks);
          break;
          
        case 'list':
          responseText = await this.handleTaskListing(userId, analysis, userTasks);
          break;
          
        case 'query':
          responseText = await this.handleTaskQuery(userId, analysis, userTasks);
          break;
          
        case 'clarify':
        default:
          // Usar a resposta sugerida pela análise
          responseText = analysis.suggestedResponseText || 
            "Não entendi completamente. Você pode me dar mais detalhes?";
      }
      
      // Enviar a resposta
      await this.sendMessage(phoneNumberId, from, responseText);
      
      // Adicionar resposta ao histórico
      await this.addToConversationHistory(from, 'assistant', responseText);
      
      // Se a análise referenciou um compromisso específico, atualizar como último discutido
      if (analysis.referencedTask?.id) {
        const task = userTasks.find(t => t.id === analysis.referencedTask.id);
        if (task) {
          await this.updateLastDiscussedTask(from, task.id, task.title);
        }
      }
    } catch (error) {
      this.logger.error(`Erro no processamento inteligente: ${error.message}`, error.stack);
      
      // Enviar mensagem de erro genérica
      await this.sendMessage(
        phoneNumberId,
        from,
        "Desculpe, tive um problema ao processar sua mensagem. Pode tentar novamente?"
      );
    }
  }

  /**
   * Processa atualização de compromisso
   */
  async handleTaskUpdate(
    userId: string,
    analysis: any,
    userTasks: any[]
  ): Promise<string> {
    try {
      // Verificar se temos um compromisso referenciado
      if (!analysis.referencedTask?.id) {
        return "Não consegui identificar qual compromisso você quer alterar. Pode ser mais específico?";
      }
      
      // Verificar se o compromisso existe
      const taskToUpdate = userTasks.find(t => t.id === analysis.referencedTask.id);
      if (!taskToUpdate) {
        return "Não encontrei esse compromisso nos seus agendamentos. Pode verificar se ele existe?";
      }
      
      // Verificar se temos mudanças para aplicar
      const changes = analysis.changes || {};
      if (Object.keys(changes).filter(k => changes[k] !== undefined).length === 0) {
        return "Entendi que você quer alterar algo, mas não consegui identificar exatamente o que. Pode me dizer o que deseja mudar?";
      }
      
      // Preparar as alterações
      const updateData: any = {};
      
      if (changes.title) updateData.title = changes.title;
      
      if (changes.scheduledDate) {
        // Converter para Date se for string
        updateData.scheduledDate = typeof changes.scheduledDate === 'string' ? 
          new Date(changes.scheduledDate) : changes.scheduledDate;
      }
      
      if (changes.location) updateData.location = changes.location;
      if (changes.participants) updateData.participants = changes.participants;
      
      // Verificar se há conflitos de horário se estiver mudando a data
      if (updateData.scheduledDate) {
        const conflictingTasks = userTasks.filter(task => {
          if (task.id === taskToUpdate.id) return false; // Ignorar o próprio compromisso
          
          const taskDate = new Date(task.scheduledDate);
          const newDate = new Date(updateData.scheduledDate);
          
          // Verificar se está no mesmo dia e próximo no horário (2 horas antes ou depois)
          const timeDiff = Math.abs(taskDate.getTime() - newDate.getTime());
          const hoursDiff = timeDiff / (1000 * 60 * 60);
          
          return hoursDiff < 2 && 
            taskDate.getDate() === newDate.getDate() &&
            taskDate.getMonth() === newDate.getMonth() &&
            taskDate.getFullYear() === newDate.getFullYear();
        });
        
        if (conflictingTasks.length > 0) {
          const conflict = conflictingTasks[0];
          const conflictTime = new Date(conflict.scheduledDate).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
          });
          
          // Mencionar o conflito, mas ainda assim fazer a atualização
          const updatedTask = await this.tasksService.update(taskToUpdate.id, updateData);
          
          // Descrever as alterações feitas
          const changeDescriptions = [];
          
          if (updateData.title && updateData.title !== taskToUpdate.title) {
            changeDescriptions.push(`o título para "${updateData.title}"`);
          }
          
          if (updateData.scheduledDate) {
            const oldTime = new Date(taskToUpdate.scheduledDate).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit'
            });
            
            const newTime = new Date(updateData.scheduledDate).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit'
            });
            
            if (oldTime !== newTime) {
              changeDescriptions.push(`o horário de ${oldTime} para ${newTime}`);
            }
          }
          
          if (updateData.location && updateData.location !== taskToUpdate.location) {
            changeDescriptions.push(`o local para "${updateData.location}"`);
          }
          
          if (updateData.participants) {
            changeDescriptions.push(`os participantes para "${updateData.participants.join(', ')}"`);
          }
          
          const changesText = changeDescriptions.join(' e ');
          
          return `Alterei ${changesText} do seu compromisso "${taskToUpdate.title}". Observação: você já tem outro compromisso "${conflict.title}" às ${conflictTime} próximo desse horário.`;
        }
      }
      
      // Aplicar as alterações
      const updatedTask = await this.tasksService.update(taskToUpdate.id, updateData);
      
      // Gerar mensagem de confirmação conversacional
      // Descrever as alterações feitas
      const changeDescriptions = [];
      
      if (updateData.title && updateData.title !== taskToUpdate.title) {
        changeDescriptions.push(`o título para "${updateData.title}"`);
      }
      
      if (updateData.scheduledDate) {
        const oldTime = new Date(taskToUpdate.scheduledDate).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const newTime = new Date(updateData.scheduledDate).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        });
        
        if (oldTime !== newTime) {
          changeDescriptions.push(`o horário de ${oldTime} para ${newTime}`);
        }
      }
      
      if (updateData.location && updateData.location !== taskToUpdate.location) {
        changeDescriptions.push(`o local para "${updateData.location}"`);
      }
      
      if (updateData.participants) {
        changeDescriptions.push(`os participantes para "${updateData.participants.join(', ')}"`);
      }
      
      if (changeDescriptions.length === 0) {
        return `Não houve alterações necessárias para o compromisso "${taskToUpdate.title}".`;
      }
      
      const changesText = changeDescriptions.join(' e ');
      return `Pronto! Alterei ${changesText} do seu compromisso "${taskToUpdate.title}".`;
      
    } catch (error) {
      this.logger.error(`Erro ao atualizar compromisso: ${error.message}`, error.stack);
      return "Ocorreu um erro ao tentar atualizar o compromisso. Pode tentar novamente?";
    }
  }

  /**
   * Processa criação de compromisso
   */
  async handleTaskCreation(
    userId: string,
    analysis: any
  ): Promise<string> {
    try {
      const newTaskInfo = analysis.newTaskInfo || {};
      
      // Verificar se temos informações suficientes
      if (!newTaskInfo.title || !newTaskInfo.scheduledDate) {
        return "Preciso de mais informações para criar o compromisso. Qual o título e quando será?";
      }
      
      // Converter a data para UTC antes de salvar
      const localDate = new Date(newTaskInfo.scheduledDate);
      const utcDate = new Date(localDate.getTime() + (localDate.getTimezoneOffset() * 60000));
      
      // Criar o compromisso
      const taskData = {
        userId,
        title: newTaskInfo.title,
        scheduledDate: utcDate,
        location: newTaskInfo.location,
        participants: newTaskInfo.participants,
        description: newTaskInfo.description
      };
      
      const newTask = await this.tasksService.createTask(taskData);
      
      // Formatar data e hora
      const taskDate = this.convertUTCToLocal(new Date(newTask.scheduledDate));
      const dateText = this.formatDateHumanized(taskDate);
      const timeText = this.formatTimeHumanized(taskDate);
      
      // Gerar mensagem de confirmação
      let response = `Perfeito! Agendei ${newTask.title} para ${dateText} às ${timeText}`;
      
      if (newTask.location) {
        response += ` em ${newTask.location}`;
      }
      
      if (newTask.participants && newTask.participants.length > 0) {
        response += ` com ${newTask.participants.join(', ')}`;
      }
      
      response += ".";
      
      return response;
    } catch (error) {
      this.logger.error(`Erro ao criar compromisso: ${error.message}`, error.stack);
      return "Tive um problema ao agendar seu compromisso. Pode tentar novamente com mais detalhes?";
    }
  }

  /**
   * Processa exclusão de compromisso
   */
  async handleTaskDeletion(
    userId: string,
    analysis: any,
    userTasks: any[]
  ): Promise<string> {
    try {
      // Verificar se temos um compromisso referenciado
      if (!analysis.referencedTask?.id) {
        return "Não consegui identificar qual compromisso você quer excluir. Pode ser mais específico?";
      }
      
      // Verificar se o compromisso existe
      const taskToDelete = userTasks.find(t => t.id === analysis.referencedTask.id);
      if (!taskToDelete) {
        return "Não encontrei esse compromisso nos seus agendamentos.";
      }
      
      // Excluir o compromisso
      await this.tasksService.remove(taskToDelete.id);
      
      // Gerar mensagem de confirmação
      return `Pronto! Excluí o compromisso "${taskToDelete.title}" da sua agenda.`;
    } catch (error) {
      this.logger.error(`Erro ao excluir compromisso: ${error.message}`, error.stack);
      return "Tive um problema ao excluir o compromisso. Pode tentar novamente?";
    }
  }

  /**
   * Processa listagem de compromissos
   */
  async handleTaskListing(
    userId: string,
    analysis: any,
    userTasks: any[]
  ): Promise<string> {
    try {
      if (!userTasks || userTasks.length === 0) {
        return "Você não tem nenhum compromisso agendado no momento.";
      }
      
      // Filtrar para mostrar apenas compromissos futuros
      const now = new Date();
      const upcomingTasks = userTasks
        .filter(task => this.convertUTCToLocal(new Date(task.scheduledDate)) >= now)
        .sort((a, b) => new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime());
      
      if (upcomingTasks.length === 0) {
        return "Você não tem compromissos futuros agendados. Quer criar um novo?";
      }
      
      // Formatar compromissos
      const formattedTasks = upcomingTasks.map(task => {
        const date = this.convertUTCToLocal(new Date(task.scheduledDate));
        
        // Verificar se é hoje ou amanhã
        const isToday = this.isSameDay(date, now);
        const isTomorrow = this.isSameDay(new Date(now.getTime() + 24 * 60 * 60 * 1000), date);
        
        let dateText;
        if (isToday) {
          dateText = "hoje";
        } else if (isTomorrow) {
          dateText = "amanhã";
        } else {
          dateText = date.toLocaleDateString('pt-BR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          });
        }
        
        const timeText = date.toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        });
        
        return `• ${task.title}: ${dateText} às ${timeText}${task.location ? ` em ${task.location}` : ''}`;
      });
      
      // Gerar mensagem de listagem
      let response = `Aqui estão seus próximos compromissos:\n\n${formattedTasks.join('\n\n')}`;
      
      return response;
    } catch (error) {
      this.logger.error(`Erro ao listar compromissos: ${error.message}`, error.stack);
      return "Tive um problema ao buscar seus compromissos. Pode tentar novamente?";
    }
  }

  /**
   * Processa consulta sobre compromissos
   */
  async handleTaskQuery(
    userId: string,
    analysis: any,
    userTasks: any[]
  ): Promise<string> {
    try {
      // Verificar se temos um compromisso referenciado
      if (analysis.referencedTask?.id) {
        // Consulta sobre um compromisso específico
        const task = userTasks.find(t => t.id === analysis.referencedTask.id);
        if (!task) {
          return "Não encontrei esse compromisso nos seus agendamentos.";
        }
        
        // Formatar data e hora
        const taskDate = this.convertUTCToLocal(new Date(task.scheduledDate));
        
        // Verificar se é hoje ou amanhã
        const now = new Date();
        const isToday = this.isSameDay(taskDate, now);
        const isTomorrow = this.isSameDay(new Date(now.getTime() + 24 * 60 * 60 * 1000), taskDate);
        
        let dateText;
        if (isToday) {
          dateText = "hoje";
        } else if (isTomorrow) {
          dateText = "amanhã";
        } else {
          dateText = taskDate.toLocaleDateString('pt-BR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          });
        }
        
        const timeText = taskDate.toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        });
        
        // Gerar resposta
        let response = `Seu compromisso "${task.title}" está agendado para ${dateText} às ${timeText}`;
        
        if (task.location) {
          response += ` em ${task.location}`;
        }
        
        if (task.participants && task.participants.length > 0) {
          response += ` com ${task.participants.join(', ')}`;
        }
        
        response += ".";
        
        return response;
      } 
      else {
        // Consulta geral sobre compromissos
        const now = new Date();
        const upcomingTasks = userTasks
          .filter(task => this.convertUTCToLocal(new Date(task.scheduledDate)) >= now)
          .sort((a, b) => new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime());
        
        if (upcomingTasks.length === 0) {
          return "Você não tem compromissos agendados para os próximos dias.";
        }
        
        // Mostrar apenas o próximo compromisso
        const nextTask = upcomingTasks[0];
        const taskDate = this.convertUTCToLocal(new Date(nextTask.scheduledDate));
        
        // Verificar se é hoje ou amanhã
        const isToday = this.isSameDay(taskDate, now);
        const isTomorrow = this.isSameDay(new Date(now.getTime() + 24 * 60 * 60 * 1000), taskDate);
        
        let dateText;
        if (isToday) {
          dateText = "hoje";
        } else if (isTomorrow) {
          dateText = "amanhã";
        } else {
          dateText = taskDate.toLocaleDateString('pt-BR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          });
        }
        
        const timeText = taskDate.toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        });
        
        // Gerar resposta
        let response = `Seu próximo compromisso é "${nextTask.title}" ${dateText} às ${timeText}`;
        
        if (nextTask.location) {
          response += ` em ${nextTask.location}`;
        }
        
        if (upcomingTasks.length > 1) {
          response += `. Você tem outros ${upcomingTasks.length - 1} compromissos agendados para os próximos dias.`;
        } else {
          response += ".";
        }
        
        return response;
      }
    } catch (error) {
      this.logger.error(`Erro ao consultar compromissos: ${error.message}`, error.stack);
      return "Tive um problema ao buscar informações sobre seus compromissos. Pode tentar novamente?";
    }
  }

  /**
   * Converte uma data UTC para o fuso horário local
   */
  private convertUTCToLocal(date: Date): Date {
    const localDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
    return localDate;
  }

  /**
   * Formata datas de maneira natural, como uma pessoa falaria
   */
  formatDateHumanized(date: Date): string {
    const localDate = this.convertUTCToLocal(date);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const dayAfterTomorrow = new Date(now);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
    
    // Verificar se é hoje, amanhã, ou depois de amanhã
    if (this.isSameDay(localDate, now)) {
      return "hoje";
    } else if (this.isSameDay(localDate, tomorrow)) {
      return "amanhã";
    } else if (this.isSameDay(localDate, dayAfterTomorrow)) {
      return "depois de amanhã";
    }
    
    // Verificar se é esta semana
    const dayDiff = this.getDayDifference(now, localDate);
    if (dayDiff < 7) {
      const weekdayName = localDate.toLocaleDateString('pt-BR', { weekday: 'long' });
      return weekdayName;
    }
    
    // Para datas mais distantes, usar formato mais completo
    return localDate.toLocaleDateString('pt-BR', { 
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
  }

  /**
   * Formata horários de maneira natural
   */
  formatTimeHumanized(date: Date): string {
    const localDate = this.convertUTCToLocal(date);
    const hours = localDate.getHours();
    const minutes = localDate.getMinutes();
    
    // Formatos especiais para horários "redondos"
    if (minutes === 0) {
      if (hours === 12) {
        return "meio-dia";
      } else if (hours === 0) {
        return "meia-noite";
      } else {
        return `${hours} horas`;
      }
    } else if (minutes === 30) {
      if (hours === 12) {
        return "meio-dia e meia";
      } else if (hours === 0) {
        return "meia-noite e meia";
      } else {
        return `${hours} e meia`;
      }
    } else {
      // Formato padrão para outros horários
      return localDate.toLocaleTimeString('pt-BR', { 
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    }
  }

  /**
   * Verifica se duas datas são no mesmo dia
   */
  isSameDay(date1: Date, date2: Date): boolean {
    return date1.getDate() === date2.getDate() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getFullYear() === date2.getFullYear();
  }

  /**
   * Calcula a diferença em dias entre duas datas
   */
  getDayDifference(date1: Date, date2: Date): number {
    const diffTime = Math.abs(date2.getTime() - date1.getTime());
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Gera uma resposta conversacional para situações comuns
   */
  generateConversationalResponse(intent: string, task?: any, changes?: any): string {
    switch (intent) {
      case 'greeting':
        return "Olá! Em que posso ajudar hoje?";
        
      case 'task_created':
        return this.formatAppointmentConfirmation(task);
        
      case 'task_updated':
        return this.formatAppointmentConfirmation(task, changes);
        
      case 'task_deleted':
        return `Prontinho! O compromisso "${task.title}" foi removido da sua agenda.`;
        
      case 'no_tasks':
        return "Você não tem nenhum compromisso agendado para os próximos dias.";
        
      case 'confirmation':
        return "Feito!";
        
      case 'not_understood':
        return "Desculpe, não entendi bem o que você quer fazer. Pode me explicar de outra forma?";
        
      default:
        return "Como posso ajudar com seus compromissos?";
    }
  }
  
  /**
   * Formata um compromisso de forma conversacional para confirmações
   */
  formatAppointmentConfirmation(task: any, changes?: any): string {
    const taskDate = new Date(task.scheduledDate);
    const dateText = this.formatDateHumanized(taskDate);
    const timeText = this.formatTimeHumanized(taskDate);
    
    let response = '';
    
    // Se tiver mudanças, formatar como confirmação de atualização
    if (changes) {
      const changeDescriptions = [];
      
      if (changes.title && changes.title !== task.title) {
        changeDescriptions.push(`o título para "${changes.title}"`);
      }
      
      if (changes.scheduledDate) {
        const oldDate = new Date(task.scheduledDate);
        const newDate = new Date(changes.scheduledDate);
        
        if (!this.isSameDay(oldDate, newDate)) {
          const oldDateText = this.formatDateHumanized(oldDate);
          const newDateText = this.formatDateHumanized(newDate);
          changeDescriptions.push(`a data de ${oldDateText} para ${newDateText}`);
        }
        
        const oldTimeText = this.formatTimeHumanized(oldDate);
        const newTimeText = this.formatTimeHumanized(newDate);
        
        if (oldTimeText !== newTimeText) {
          changeDescriptions.push(`o horário de ${oldTimeText} para ${newTimeText}`);
        }
      }
      
      if (changes.location && changes.location !== task.location) {
        changeDescriptions.push(`o local para "${changes.location}"`);
      }
      
      if (changes.participants) {
        changeDescriptions.push(`os participantes para "${changes.participants.join(', ')}"`);
      }
      
      if (changeDescriptions.length === 0) {
        response = `Não houve alterações necessárias para o "${task.title}".`;
      } else {
        const changesText = changeDescriptions.join(' e ');
        response = `Pronto! Alterei ${changesText} do seu compromisso "${task.title}".`;
      }
    } 
    // Caso contrário, é uma confirmação de novo compromisso
    else {
      response = `Perfeito! Agendei ${task.title} para ${dateText} às ${timeText}`;
      
      if (task.location) {
        response += ` em ${task.location}`;
      }
      
      if (task.participants && task.participants.length > 0) {
        response += ` com ${task.participants.join(', ')}`;
      }
      
      response += ".";
    }
    
    return response;
  }

  private async handleCancelCommand(phoneNumberId: string, from: string): Promise<void> {
    try {
      // Limpar o histórico de conversa para começar de novo
      const history = await this.getConversationHistory(from);
      
      if (history) {
        history.messages = [];
        history.lastTaskDiscussed = undefined;
      }
      
      // Também limpar qualquer estado anterior no sistema atual
      await this.conversationService.clearConversationState(from);
      
      // Mensagem mais conversacional
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Tudo bem, esqueci nossa conversa anterior. Em que posso ajudar agora?'
      );
    } catch (error) {
      this.logger.error(`Erro ao cancelar conversa: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async handleRestartCommand(phoneNumberId: string, from: string): Promise<void> {
    try {
      // Criar um novo contexto
      const newHistory = {
        messages: []
      };
      
      // Substituir o histórico existente
      this.conversationHistories.set(from, newHistory);
      
      // Também limpar qualquer estado anterior no sistema atual
      await this.conversationService.clearConversationState(from);
      
      // Mensagem de reinício
      await this.sendMessage(
        phoneNumberId, 
        from, 
        'Conversa reiniciada. Estou pronto para ajudar com seus compromissos. O que você precisa hoje?'
      );
    } catch (error) {
      this.logger.error(`Erro ao reiniciar conversa: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async handleHelpCommand(phoneNumberId: string, from: string): Promise<void> {
    const helpMessage = 
      `Olá! Sou seu assistente pessoal para gerenciar compromissos. Você pode conversar comigo naturalmente, como falaria com uma pessoa. Alguns exemplos do que posso fazer:\n\n` +
      
      `*Para criar compromissos:*\n` +
      `• "Marque uma reunião com o time amanhã às 15h"\n` +
      `• "Tenho almoço com a família quarta-feira às 12h"\n\n` +
      
      `*Para ver seus compromissos:*\n` +
      `• "Quais são meus compromissos?"\n` +
      `• "O que tenho agendado para amanhã?"\n\n` +
      
      `*Para alterar compromissos:*\n` +
      `• "Mude o almoço de amanhã para 13h"\n` +
      `• "A reunião será na sala 2, não na recepção"\n\n` +
      
      `*Para cancelar compromissos:*\n` +
      `• "Cancele minha reunião de amanhã"\n` +
      `• "Preciso desmarcar o almoço de quarta"\n\n` +
      
      `*Para saber mais sobre um compromisso:*\n` +
      `• "Quando é minha próxima reunião?"\n` +
      `• "Onde será o almoço de amanhã?"\n\n` +
      
      `Fale comigo naturalmente e eu farei o meu melhor para entender e ajudar!`;
    
    await this.sendMessage(phoneNumberId, from, helpMessage);
  }

  private async handleListCommand(phoneNumberId: string, from: string, userId: string): Promise<void> {
    try {
      // Get all tasks for the user
      const tasks = await this.tasksService.findAllByUser(userId);
      
      if (!tasks || tasks.length === 0) {
        await this.sendMessage(
          phoneNumberId,
          from,
          'Você não tem compromissos agendados. Para criar um novo compromisso, basta me dizer os detalhes, como por exemplo "Reunião amanhã às 15h".'
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
      
      // Generate list message in a more conversational style
      let message = '';
      
      if (upcomingTasks.length > 0) {
        message += 'Aqui estão seus próximos compromissos:\n\n';
        
        upcomingTasks.forEach((task, index) => {
          const date = new Date(task.scheduledDate);
          
          // Check if today or tomorrow for more natural language
          const isToday = this.isSameDay(date, today);
          const tomorrow = new Date(today);
          tomorrow.setDate(today.getDate() + 1);
          const isTomorrow = this.isSameDay(date, tomorrow);
          
          let datePhrase;
          if (isToday) {
            datePhrase = "hoje";
          } else if (isTomorrow) {
            datePhrase = "amanhã";
          } else {
            datePhrase = date.toLocaleDateString('pt-BR', {
              weekday: 'long', 
              day: 'numeric', 
              month: 'long'
            });
          }
          
          const timePhrase = date.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
          });
          
          message += `• *${task.title}* - ${datePhrase} às ${timePhrase}`;
          
          if (task.location) {
            message += ` em ${task.location}`;
          }
          
          if (task.participants && task.participants.length > 0) {
            message += ` com ${task.participants.join(', ')}`;
          }
          
          message += '\n\n';
        });
      } else {
        message += 'Você não tem compromissos futuros agendados. Para criar um novo compromisso, basta me dizer os detalhes.\n\n';
      }
      
      if (pastTasks.length > 0) {
        // Show only recent past tasks
        const recentPastTasks = pastTasks
          .sort((a, b) => 
            new Date(b.scheduledDate).getTime() - new Date(a.scheduledDate).getTime()
          )
          .slice(0, 3);
        
        if (recentPastTasks.length > 0) {
          message += 'Compromissos recentes:\n\n';
          
          recentPastTasks.forEach((task) => {
            const date = new Date(task.scheduledDate);
            const formattedDate = date.toLocaleDateString('pt-BR', {
              weekday: 'long', 
              day: 'numeric', 
              month: 'long',
              hour: '2-digit',
              minute: '2-digit'
            });
            
            message += `• *${task.title}* - ${formattedDate}\n\n`;
          });
        }
      }
      
      message += 'Para saber mais sobre um compromisso específico, basta perguntar. Para criar, alterar ou excluir compromissos, fale naturalmente comigo.';
      
      await this.sendMessage(phoneNumberId, from, message);
      
    } catch (error) {
      this.logger.error(`Erro ao listar compromissos: ${error.message}`, error.stack);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Ocorreu um erro ao buscar seus compromissos. Pode tentar novamente mais tarde?'
      );
    }
  }

  async sendMessage(phoneNumberId: string, to: string, message: string): Promise<void> {
    try {
      // Verificar se não estamos repetindo a última mensagem enviada
      const history = await this.getConversationHistory(to);
      
      if (history && history.messages.length > 0) {
        const lastMessage = history.messages.find(m => m.role === 'assistant');
        
        if (lastMessage && lastMessage.content === message) {
          // Evitar enviar a mesma mensagem duas vezes
          this.logger.log('Evitando enviar mensagem duplicada');
          return;
        }
      }
      
      // Proceder com o envio da mensagem
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
      this.logger.log(`Mensagem enviada para ${to}`);
    } catch (error) {
      this.logger.error(`Erro ao enviar mensagem WhatsApp: ${error.message}`, error.stack);
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