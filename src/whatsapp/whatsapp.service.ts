import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OpenaiService } from '../openai/openai.service';
import { TasksService } from '../tasks/tasks.service';
import { lastValueFrom } from 'rxjs';
import { SupabaseService } from '../supabase/supabase.service';
import { ConversationService } from './conversation.service';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import * as customParseFormat from 'dayjs/plugin/customParseFormat';
import * as isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import 'dayjs/locale/pt-br';

// Configurar plugins do dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrAfter);
dayjs.locale('pt-br');

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
      // Extract message data from webhook payload
      const entry = body.entry[0];
      const change = entry.changes[0];
      const value = change.value;
      const message = value.messages[0];
      const from = message.from;
      const phoneNumberId = value.metadata.phone_number_id;
      const timestamp = message.timestamp;
      
      let messageText = '';
      let isForwarded = false;

      // Handle different message types
      if (message.type === 'text' && message.text?.body) {
        messageText = message.text.body;
      } else if (message.type === 'image' && message.image?.caption) {
        messageText = message.image.caption;
      } else {
        this.logger.warn(`Unsupported message type: ${message.type}`);
        return;
      }

      // Check if message is forwarded
      if (message.context?.forwarded) {
        isForwarded = true;
        messageText = `[Mensagem encaminhada] ${messageText}`;
      }
      
      this.logger.log(`Received message from ${from}: ${messageText}`);
      
      // Get or create user
      const userId = await this.getOrCreateUserByPhone(from);
      if (!userId) {
        this.logger.error(`Could not get or create user for phone ${from}`);
        return;
      }
      
      // Process the message as part of a conversation, passing the timestamp
      await this.processConversation(phoneNumberId, from, userId, messageText, timestamp);
      
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

  async processConversation(
    phoneNumberId: string,
    from: string,
    userId: string,
    messageText: string,
    timestamp: string
  ): Promise<void> {
    try {
      // Convert timestamp string to Date object
      const messageDate = new Date(parseInt(timestamp) * 1000);
      
      // Process the message intelligently
      await this.processMessageIntelligently(
        phoneNumberId,
        from,
        userId,
        messageText,
        timestamp
      );
    } catch (error) {
      this.logger.error(`Erro no processamento da conversa: ${error.message}`);
      await this.sendMessage(
        phoneNumberId,
        from,
        'Desculpe, tive um problema ao processar sua mensagem. Pode tentar novamente?'
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
    messageText: string,
    timestamp: string
  ): Promise<void> {
    try {
    
      const conversationState = await this.conversationService.getConversationState(from);
      
      await this.addToConversationHistory(from, 'user', messageText);
      
      //context
      const userTasks = await this.tasksService.findAllByUser(userId);
      
      const history = await this.getConversationHistory(from);
      const conversationMessages = history.messages.map(m => `${m.role}: ${m.content}`);
      
      const analysis = await this.openaiService.analyzeConversation(
        messageText,
        conversationMessages,
        userTasks,
        timestamp
      );
  
      analysis.messageText = messageText;
      analysis.from = from;
      
      let responseText = '';
      
      switch (analysis.intent) {
        case 'update':
          responseText = await this.handleTaskUpdate(userId, analysis, userTasks);
          break;
          
        case 'create':
          const hasTimeInMessage = messageText && (
            messageText.includes('às') || 
            messageText.includes('as') || 
            messageText.includes('hora') || 
            messageText.includes('horas') ||
            /\d{1,2}[:h]\d{0,2}/.test(messageText)
          );
          
          const brazilianDatePattern = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
          const dateMatch = messageText.match(brazilianDatePattern);
          
          if (dateMatch) {
            const day = dateMatch[1].padStart(2, '0');
            const month = dateMatch[2].padStart(2, '0');
            const year = dateMatch[3];
            analysis.newTaskInfo.scheduledDate = `${year}-${month}-${day}`;
            this.logger.log(`Data convertida de DD/MM/YYYY para YYYY-MM-DD: ${analysis.newTaskInfo.scheduledDate}`);
          }
          
          if (!hasTimeInMessage && analysis.newTaskInfo && analysis.newTaskInfo.scheduledDate) {
            // Se não mencionou horário, perguntar qual o horário desejado
            const scheduledDate = analysis.newTaskInfo.scheduledDate;
            const formattedDate = this.formatDateHumanized(scheduledDate);
            
            // Salvar o estado da conversa para continuar depois
            await this.conversationService.saveConversationState(from, {
              ...conversationState,
              pendingTaskCreation: {
                title: analysis.newTaskInfo.title,
                scheduledDate: analysis.newTaskInfo.scheduledDate,
                location: analysis.newTaskInfo.location,
                participants: analysis.newTaskInfo.participants
              }
            });
            
            responseText = `Qual horário você deseja para o compromisso "${analysis.newTaskInfo.title}" em ${formattedDate}?`;
          } else {
            responseText = await this.handleTaskCreation(userId, analysis, from, conversationState);
          }
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
          // Use the suggested response from analysis
          responseText = analysis.suggestedResponseText || 
            "Não entendi completamente. Você pode me dar mais detalhes?";
      }
      
      // Send the response
      await this.sendMessage(phoneNumberId, from, responseText);
      
      // Add response to history
      await this.addToConversationHistory(from, 'assistant', responseText);
      
      // If analysis referenced a specific task, update as last discussed
      if (analysis.referencedTask?.id) {
        const task = userTasks.find(t => t.id === analysis.referencedTask.id);
        if (task) {
          await this.updateLastDiscussedTask(from, task.id, task.title);
        }
      }
      
    } catch (error) {
      this.logger.error(`Error processing message intelligently: ${error.message}`, error.stack);
      await this.sendMessage(phoneNumberId, from, 'Desculpe, tive um problema ao processar sua mensagem. Pode tentar novamente?');
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
        // Converter para dayjs se for string
        let taskDate = dayjs.isDayjs(changes.scheduledDate) ? 
          changes.scheduledDate : 
          dayjs.tz(changes.scheduledDate, 'America/Sao_Paulo');
        
        // Se a mensagem contém um horário, extrair e adicionar à data
        const messageText = analysis.messageText || '';
        const hasTimeInMessage = messageText && (
          messageText.includes('às') || 
          messageText.includes('as') || 
          messageText.includes('hora') || 
          messageText.includes('horas') ||
          /\d{1,2}[:h]\d{0,2}/.test(messageText)
        );
        
        if (hasTimeInMessage) {
          // Tentar extrair o horário da mensagem
          const timeMatch = messageText.match(/(\d{1,2})[:h](\d{0,2})/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
            
            // Definir o horário no objeto dayjs
            taskDate = taskDate.hour(hours).minute(minutes).second(0);
          }
        } else {
          // Manter o horário original se não foi especificado um novo
          const originalDate = dayjs.tz(taskToUpdate.scheduledDate, 'America/Sao_Paulo');
          taskDate = taskDate.hour(originalDate.hour()).minute(originalDate.minute()).second(0);
        }
        
        // Converter para UTC para salvar no banco
        updateData.scheduledDate = taskDate.utc().toDate();
      }
      
      if (changes.location) updateData.location = changes.location;
      if (changes.participants) updateData.participants = changes.participants;
      
      // Verificar se há conflitos de horário se estiver mudando a data
      if (updateData.scheduledDate) {
        const newDate = dayjs.tz(updateData.scheduledDate, 'America/Sao_Paulo');
        
        const conflictingTasks = userTasks.filter(task => {
          if (task.id === taskToUpdate.id) return false; // Ignorar o próprio compromisso
          
          const taskDate = dayjs.tz(task.scheduledDate, 'America/Sao_Paulo');
          
          // Verificar se está no mesmo dia e próximo no horário (2 horas antes ou depois)
          const timeDiff = Math.abs(taskDate.diff(newDate, 'hour'));
          
          return timeDiff < 2 && taskDate.isSame(newDate, 'day');
        });
        
        if (conflictingTasks.length > 0) {
          const conflict = conflictingTasks[0];
          const conflictTime = this.formatTimeHumanized(conflict.scheduledDate);
          
          // Mencionar o conflito, mas ainda assim fazer a atualização
          const updatedTask = await this.tasksService.update(taskToUpdate.id, updateData);
          
          // Descrever as alterações feitas
          const changeDescriptions = [];
          
          if (updateData.title && updateData.title !== taskToUpdate.title) {
            changeDescriptions.push(`o título para "${updateData.title}"`);
          }
          
          if (updateData.scheduledDate) {
            const oldDate = dayjs.tz(taskToUpdate.scheduledDate, 'America/Sao_Paulo');
            const newDate = dayjs.tz(updateData.scheduledDate, 'America/Sao_Paulo');
            const oldTime = this.formatTimeHumanized(oldDate);
            const newTime = this.formatTimeHumanized(newDate);
            
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
        const oldDate = dayjs.tz(taskToUpdate.scheduledDate, 'America/Sao_Paulo');
        const newDate = dayjs.tz(updateData.scheduledDate, 'America/Sao_Paulo');
        const oldTime = this.formatTimeHumanized(oldDate);
        const newTime = this.formatTimeHumanized(newDate);
        
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
    analysis: any,
    from: string,
    conversationState: any
  ): Promise<string> {
    try {
      const newTaskInfo = analysis.newTaskInfo || {};
      
      // Verificar se temos informações suficientes
      if (!newTaskInfo.title || !newTaskInfo.scheduledDate) {
        return "Preciso de mais informações para criar o compromisso. Qual o título e quando será?";
      }
      
      this.logger.log(`Data recebida do OpenAI: ${newTaskInfo.scheduledDate}`);
      
      // Criar objeto dayjs com timezone
      let taskDate = dayjs.tz(newTaskInfo.scheduledDate, 'America/Sao_Paulo');
      
      // Verificar se a mensagem contém um horário
      const messageText = analysis.messageText || '';
      const hasTimeInMessage = messageText && (
        messageText.includes('às') || 
        messageText.includes('as') || 
        messageText.includes('hora') || 
        messageText.includes('horas') ||
        /\d{1,2}[:h]\d{0,2}/.test(messageText)
      );
      
      // Se a mensagem contém um horário, extrair e adicionar à data
      if (hasTimeInMessage) {
        // Tentar extrair o horário da mensagem
        const timeMatch = messageText.match(/(\d{1,2})[:h](\d{0,2})/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
          
          // Definir o horário no objeto dayjs
          taskDate = taskDate.hour(hours).minute(minutes).second(0);
          this.logger.log(`Horário extraído da mensagem: ${hours}:${minutes}`);
        }
      } else {
        // Se não tem horário na mensagem, usar horário padrão (meio-dia)
        taskDate = taskDate.hour(12).minute(0).second(0);
      }
      
      this.logger.log(`Data local: ${taskDate.format()}`);
      
      // Manter a data no fuso horário local ao salvar no banco
      const utcDate = taskDate.toDate();
      this.logger.log(`Data UTC: ${utcDate.toISOString()}`);

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
      
      // Formatar a data para exibição usando o objeto dayjs original
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
        return "Não consegui identificar qual compromisso você quer remover. Pode ser mais específico?";
      }
      
      // Verificar se o compromisso existe
      const taskToDelete = userTasks.find(t => t.id === analysis.referencedTask.id);
      if (!taskToDelete) {
        return "Não encontrei esse compromisso nos seus agendamentos. Pode verificar se ele existe?";
      }
      
      // Confirmar a exclusão
      await this.tasksService.remove(taskToDelete.id);
      
      // Gerar mensagem de confirmação conversacional
      const taskDate = dayjs.tz(taskToDelete.scheduledDate, 'America/Sao_Paulo');
      const time = this.formatTimeHumanized(taskDate);
      const date = this.formatDateHumanized(taskDate);
      
      return `Pronto! Removi o compromisso "${taskToDelete.title}" que estava agendado para ${date} às ${time}.`;
      
    } catch (error) {
      this.logger.error(`Erro ao remover compromisso: ${error.message}`, error.stack);
      return "Ocorreu um erro ao tentar remover o compromisso. Pode tentar novamente?";
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
      // Filtrar e ordenar tarefas
      const now = dayjs().tz('America/Sao_Paulo');
      
      // Filtrar tarefas futuras
      const upcomingTasks = userTasks
        .filter(task => {
          const taskDate = dayjs.tz(task.scheduledDate, 'America/Sao_Paulo');
          return taskDate.isAfter(now);
        })
        .sort((a, b) => {
          const dateA = dayjs.tz(a.scheduledDate, 'America/Sao_Paulo');
          const dateB = dayjs.tz(b.scheduledDate, 'America/Sao_Paulo');
          return dateA.unix() - dateB.unix();
        });
      
      if (upcomingTasks.length === 0) {
        return "Você não tem compromissos agendados para os próximos dias.";
      }
      
      // Agrupar tarefas por data
      const tasksByDate = new Map<string, any[]>();
      
      upcomingTasks.forEach(task => {
        const taskDate = dayjs.tz(task.scheduledDate, 'America/Sao_Paulo');
        const dateKey = taskDate.format('YYYY-MM-DD');
        
        if (!tasksByDate.has(dateKey)) {
          tasksByDate.set(dateKey, []);
        }
        
        tasksByDate.get(dateKey).push(task);
      });
      
      // Gerar resposta formatada
      let response = "Seus próximos compromissos:\n\n";
      
      for (const [dateKey, tasks] of tasksByDate) {
        const date = dayjs.tz(dateKey, 'America/Sao_Paulo');
        const dateText = this.formatDateHumanized(date);
        
        response += `${dateText}:\n`;
        
        tasks.forEach(task => {
          const taskDate = dayjs.tz(task.scheduledDate, 'America/Sao_Paulo');
          const time = this.formatTimeHumanized(taskDate);
          response += `- ${time}: ${task.title}`;
          
          if (task.location) {
            response += ` em ${task.location}`;
          }
          
          if (task.participants && task.participants.length > 0) {
            response += ` com ${task.participants.join(', ')}`;
          }
          
          response += '\n';
        });
        
        response += '\n';
      }
      
      return response;
      
    } catch (error) {
      this.logger.error(`Erro ao listar compromissos: ${error.message}`, error.stack);
      return "Ocorreu um erro ao tentar listar seus compromissos. Pode tentar novamente?";
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
      if (!analysis.referencedTask?.id) {
        return "Não consegui identificar qual compromisso você quer consultar. Pode ser mais específico?";
      }
      
      // Verificar se o compromisso existe
      const task = userTasks.find(t => t.id === analysis.referencedTask.id);
      if (!task) {
        return "Não encontrei esse compromisso nos seus agendamentos. Pode verificar se ele existe?";
      }
      
      // Gerar resposta detalhada
      const taskDate = dayjs.tz(task.scheduledDate, 'America/Sao_Paulo');
      const time = this.formatTimeHumanized(taskDate);
      const date = this.formatDateHumanized(taskDate);
      
      let response = `O compromisso "${task.title}" está agendado para ${date} às ${time}.`;
      
      if (task.location) {
        response += `\nLocal: ${task.location}`;
      }
      
      if (task.participants && task.participants.length > 0) {
        response += `\nParticipantes: ${task.participants.join(', ')}`;
      }
      
      // Verificar se há conflitos de horário
      const conflictingTasks = userTasks.filter(t => {
        if (t.id === task.id) return false;
        
        const otherDate = dayjs.tz(t.scheduledDate, 'America/Sao_Paulo');
        const timeDiff = Math.abs(otherDate.diff(taskDate, 'hour'));
        
        return timeDiff < 2 && otherDate.isSame(taskDate, 'day');
      });
      
      if (conflictingTasks.length > 0) {
        response += '\n\nObservação: Você tem outros compromissos próximos a este horário:';
        conflictingTasks.forEach(conflict => {
          const conflictTime = this.formatTimeHumanized(conflict.scheduledDate);
          response += `\n- "${conflict.title}" às ${conflictTime}`;
        });
      }
      
      return response;
      
    } catch (error) {
      this.logger.error(`Erro ao consultar compromisso: ${error.message}`, error.stack);
      return "Ocorreu um erro ao tentar consultar o compromisso. Pode tentar novamente?";
    }
  }

  /**
   * Converte uma data UTC para o fuso horário local
   */
  private convertUTCToLocal(date: Date | string | dayjs.Dayjs): dayjs.Dayjs {
    if (dayjs.isDayjs(date)) {
      return date.tz('America/Sao_Paulo');
    }
    return dayjs.utc(date).tz('America/Sao_Paulo');
  }

  /**
   * Formata datas de maneira natural, como uma pessoa falaria
   */
  formatDateHumanized(date: dayjs.Dayjs | Date | string): string {
    // Garantir que a data está no formato dayjs com timezone correto
    const localDate = dayjs.isDayjs(date) ? 
      date.tz('America/Sao_Paulo') : 
      dayjs.tz(date, 'America/Sao_Paulo');
    
    const now = dayjs().tz('America/Sao_Paulo');
    
    // Verificar se é hoje, amanhã, ou depois de amanhã
    if (localDate.isSame(now, 'day')) {
      return "hoje";
    } else if (localDate.isSame(now.add(1, 'day'), 'day')) {
      return "amanhã";
    } else if (localDate.isSame(now.add(2, 'day'), 'day')) {
      return "depois de amanhã";
    }
    
    // Para datas mais distantes, usar formato mais completo
    return localDate.format('dddd, D [de] MMMM');
  }

  /**
   * Formata horários de maneira natural
   */
  formatTimeHumanized(date: dayjs.Dayjs | Date | string): string {
    // Garantir que a data está no formato dayjs com timezone correto
    const localDate = dayjs.isDayjs(date) ? 
      date.tz('America/Sao_Paulo') : 
      dayjs.tz(date, 'America/Sao_Paulo');
    
    const hours = localDate.hour();
    const minutes = localDate.minute();
    
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
      return localDate.format('HH:mm');
    }
  }

  /**
   * Verifica se duas datas são no mesmo dia
   */
  isSameDay(date1: dayjs.Dayjs | Date | string, date2: dayjs.Dayjs | Date | string): boolean {
    const d1 = dayjs.isDayjs(date1) ? date1 : dayjs.tz(date1, 'America/Sao_Paulo');
    const d2 = dayjs.isDayjs(date2) ? date2 : dayjs.tz(date2, 'America/Sao_Paulo');
    return d1.isSame(d2, 'day');
  }

  /**
   * Calcula a diferença em dias entre duas datas
   */
  getDayDifference(date1: dayjs.Dayjs | Date | string, date2: dayjs.Dayjs | Date | string): number {
    const d1 = dayjs.isDayjs(date1) ? date1 : dayjs.tz(date1, 'America/Sao_Paulo');
    const d2 = dayjs.isDayjs(date2) ? date2 : dayjs.tz(date2, 'America/Sao_Paulo');
    return Math.abs(d2.diff(d1, 'day'));
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
    const taskDate = this.convertUTCToLocal(new Date(task.scheduledDate));
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
      const today = dayjs().startOf('day');
      
      const pastTasks = tasks.filter(task => dayjs(task.scheduledDate).isBefore(today));
      const upcomingTasks = tasks.filter(task => dayjs(task.scheduledDate).isSameOrAfter(today));
      
      // Sort upcoming tasks by date
      upcomingTasks.sort((a, b) => 
        dayjs(a.scheduledDate).unix() - dayjs(b.scheduledDate).unix()
      );
      
      // Generate list message in a more conversational style
      let message = '';
      
      if (upcomingTasks.length > 0) {
        message += 'Aqui estão seus próximos compromissos:\n\n';
        
        upcomingTasks.forEach((task, index) => {
          const date = dayjs.tz(task.scheduledDate, 'America/Sao_Paulo');
          
          // Check if today or tomorrow for more natural language
          const isToday = date.isSame(today, 'day');
          const isTomorrow = date.isSame(today.add(1, 'day'), 'day');
          
          let datePhrase;
          if (isToday) {
            datePhrase = "hoje";
          } else if (isTomorrow) {
            datePhrase = "amanhã";
          } else {
            datePhrase = date.format('dddd, D [de] MMMM');
          }
          
          const timePhrase = date.format('HH:mm');
          
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
            dayjs(b.scheduledDate).unix() - dayjs(a.scheduledDate).unix()
          )
          .slice(0, 3);
        
        if (recentPastTasks.length > 0) {
          message += 'Compromissos recentes:\n\n';
          
          recentPastTasks.forEach((task) => {
            const date = dayjs.tz(task.scheduledDate, 'America/Sao_Paulo');
            const formattedDate = date.format('dddd, D [de] MMMM [às] HH:mm');
            
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