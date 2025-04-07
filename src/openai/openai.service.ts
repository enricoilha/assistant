import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface TaskInformation {
  action?: string;
  dateTime?: Date;
  location?: string;
  participants?: string[];
}

export interface CrudIntent {
  operation: 'create' | 'read' | 'update' | 'delete' | 'none';
  confidence: number;
  taskId?: string;
  updateInfo?: TaskInformation;
}

@Injectable()
export class OpenaiService {
  private readonly logger = new Logger(OpenaiService.name);
  private readonly openai: OpenAI;

  constructor(private readonly configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
  }

  async detectCrudIntent(message: string, previousContext?: any): Promise<CrudIntent> {
    try {
      const prompt = this.createCrudIntentPrompt(message, previousContext);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are an assistant that analyzes user messages to detect CRUD operations 
                     (Create, Read, Update, Delete) related to appointments. Determine if the user 
                     wants to create, view, update, or delete appointments based on their message.`
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;
      
      if (!content) {
        this.logger.warn('No content returned from OpenAI for CRUD intent detection');
        return { operation: 'none', confidence: 0 };
      }

      try {
        const parsedResult = JSON.parse(content);
        
        // Add logging to see what was detected
        this.logger.log('Detected CRUD intent:', parsedResult);
        
        return {
          operation: parsedResult.operation || 'none',
          confidence: parsedResult.confidence || 0,
          taskId: parsedResult.taskId,
          updateInfo: parsedResult.updateInfo
        };
      } catch (parseError) {
        this.logger.error(`Error parsing OpenAI response: ${parseError.message}`, parseError.stack);
        return { operation: 'none', confidence: 0 };
      }
    } catch (error) {
      this.logger.error(`Error calling OpenAI API: ${error.message}`, error.stack);
      return { operation: 'none', confidence: 0 };
    }
  }

  private createCrudIntentPrompt(message: string, previousContext?: any): string {
    const contextInfo = previousContext ? 
      `Current context: ${JSON.stringify(previousContext)}` : 
      'No previous context';
    
    return `
Analise a seguinte mensagem em português para detectar operações CRUD relacionadas a compromissos:

Mensagem: "${message}"

${contextInfo}

Identifique a intenção do usuário entre as seguintes operações:
1. CRIAR um novo compromisso (exemplos: "Reunião amanhã às 15h", "Agendar almoço quinta")
2. LER/LISTAR compromissos (exemplos: "Mostrar meus compromissos", "O que tenho agendado?")
3. ATUALIZAR um compromisso existente (exemplos: "Mudar minha reunião das 15h para 16h", "O almoço será às 13h, não às 12h", "Reunião com a equipe adiada para amanhã")
4. EXCLUIR um compromisso (exemplos: "Cancelar minha reunião de amanhã", "Remover consulta dentista")

Considere também mensagens que indicam alterações em compromissos existentes, como:
- "O almoço com a família será às 12h, não às 13h"
- "Mude o horário da reunião para 16h"
- "Reunião do financeiro será na sala 2"
- "Almoço com a família será no restaurante X"

Estas podem ser interpretadas como atualizações, mesmo quando não usam verbos como "atualizar" ou "mudar".

Retorne um objeto JSON com:
1. "operation": A operação detectada ("create", "read", "update", "delete", ou "none" se não estiver claro)
2. "confidence": Um número de 0 a 1 indicando a confiança na detecção
3. "taskId": ID da tarefa se mencionado ou extraível do contexto
4. "updateInfo": Para atualizações, inclua as informações sendo alteradas

Exemplos de interpretação:
- Para "Na verdade a reunião é às 14:00", interprete como uma operação de atualização com horário atualizado
- Para "Cancelar minha consulta de amanhã", interprete como uma operação de exclusão
- Para "Tenho uma reunião marcada para quando?", interprete como uma operação de leitura
- Para "Agendar corte de cabelo quinta-feira", interprete como uma operação de criação
- Para "O almoço será às 12h e não às 13h", interprete como uma operação de atualização com alta confiança

IMPORTANTE: Adapte sua interpretação ao contexto específico da mensagem, sem aplicar regras rígidas. O objetivo é capturar a intenção do usuário com precisão.
`;
  }

  async extractTaskInformation(message: string): Promise<TaskInformation | null> {
    try {
      this.logger.log(`Extracting task information from message: "${message}"`);
      const prompt = this.createPrompt(message);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', 
        messages: [
          {
            role: 'system',
            content: `Você é um assistente que extrai informações de compromissos de mensagens.
                      Extraia o máximo de informações possível, incluindo tipo de compromisso, data, hora,
                      local e participantes. Formate sua resposta como JSON.
                      
                      IMPORTANTE: Preste muita atenção a atualizações de horário e datas. 
                      Quando um usuário diz algo como "será às 12h, não às 13h", 
                      o horário correto é 12h.
                      
                      Quando uma mensagem contém uma correção ou atualização, sempre 
                      retorne a INFORMAÇÃO CORRETA/NOVA, nunca a informação original 
                      que está sendo corrigida.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;
      this.logger.log(`OpenAI response received: ${content}`);
      
      if (!content) {
        this.logger.warn('No content returned from OpenAI');
        return null;
      }

      try {
        const parsedResult = JSON.parse(content);
        this.logger.log(`Parsed OpenAI result: ${JSON.stringify(parsedResult)}`);
        
        // Create result object with default values
        const taskInfo: TaskInformation = {};
        
        // Handle action (appointment type)
        if (parsedResult.action) {
          taskInfo.action = parsedResult.action;
          this.logger.log(`Extracted action: ${taskInfo.action}`);
        } else {
          // Default action for lunch if message contains "almoço"
          if (message.toLowerCase().includes('almoço')) {
            taskInfo.action = 'Almoço';
            this.logger.log(`Default action set to Almoço based on keyword`);
          }
        }
        
        // Handle date/time with better error checking
        if (parsedResult.dateTime) {
          try {
            const dateObj = new Date(parsedResult.dateTime);
            if (!isNaN(dateObj.getTime())) {
              taskInfo.dateTime = dateObj;
              this.logger.log(`Extracted date: ${taskInfo.dateTime.toISOString()}`);
            } else {
              this.logger.warn(`Invalid date format returned from OpenAI: ${parsedResult.dateTime}`);
              
              // Try to parse time-only format
              if (typeof parsedResult.dateTime === 'string') {
                // Handle time format like "12:30"
                const timeMatch = parsedResult.dateTime.match(/(\d{1,2}):(\d{2})/);
                if (timeMatch) {
                  const hours = parseInt(timeMatch[1], 10);
                  const minutes = parseInt(timeMatch[2], 10);
                  
                  const today = new Date();
                  today.setHours(hours, minutes, 0, 0);
                  taskInfo.dateTime = today;
                  this.logger.log(`Constructed date from time only: ${today.toISOString()}`);
                }
              }
            }
          } catch (dateError) {
            this.logger.error(`Error parsing date: ${dateError.message}`);
          }
        } else {
          // Enhanced direct time extraction from message
          const timePatterns = [
            /(\d{1,2})[:.h](\d{0,2})/,  // Matches 12:00, 12.00, 12h00, 12h
            /(\d{1,2})\s*(horas?)/,     // Matches "12 horas", "12 hora"
            /(\d{1,2})\s*(h)/           // Matches "12 h"
          ];
          
          for (const pattern of timePatterns) {
            const match = message.match(pattern);
            if (match) {
              const hours = parseInt(match[1], 10);
              const minutes = match[2] && !isNaN(parseInt(match[2], 10)) ? 
                parseInt(match[2], 10) : 0;
              
              const today = new Date();
              today.setHours(hours, minutes, 0, 0);
              taskInfo.dateTime = today;
              this.logger.log(`Extracted time directly from message using pattern: ${today.toISOString()}`);
              break;
            }
          }
        }
        
        // Enhanced handling for location
        if (parsedResult.location) {
          taskInfo.location = parsedResult.location;
          this.logger.log(`Extracted location: ${taskInfo.location}`);
        } else {
          // Try to extract known locations from message
          const lowerMessage = message.toLowerCase();
          
          // Check for restaurant mentions
          if (lowerMessage.includes('restaurante') || lowerMessage.includes('cura')) {
            const restaurantMatch = message.match(/restaurante\s+(\w+)/i);
            if (restaurantMatch) {
              taskInfo.location = `Restaurante ${restaurantMatch[1]}`;
            } else if (lowerMessage.includes('cura')) {
              taskInfo.location = 'Restaurante Cura';
            }
            this.logger.log(`Extracted location from keywords: ${taskInfo.location}`);
          }
          
          // Check for office/room mentions
          if (lowerMessage.includes('sala') || lowerMessage.includes('escritório') || lowerMessage.includes('escritorio')) {
            const roomMatch = message.match(/sala\s+(\w+)/i) || message.match(/escritório\s+(\w+)/i) || message.match(/escritorio\s+(\w+)/i);
            if (roomMatch) {
              taskInfo.location = `Sala ${roomMatch[1]}`;
              this.logger.log(`Extracted room location: ${taskInfo.location}`);
            }
          }
        }
        
        // Handle participants with improved extraction
        if (parsedResult.participants && Array.isArray(parsedResult.participants)) {
          taskInfo.participants = parsedResult.participants;
          this.logger.log(`Extracted participants: ${taskInfo.participants.join(', ')}`);
        } else {
          // Try direct extraction for common participant mentions
          const lowerMessage = message.toLowerCase();
          const commonParticipants = [
            {keyword: 'família', value: 'família'},
            {keyword: 'familia', value: 'família'},
            {keyword: 'equipe', value: 'equipe'},
            {keyword: 'time', value: 'equipe'},
            {keyword: 'financeiro', value: 'financeiro'},
            {keyword: 'marketing', value: 'marketing'},
            {keyword: 'vendas', value: 'vendas'},
            {keyword: 'recursos humanos', value: 'RH'},
            {keyword: 'rh', value: 'RH'},
            {keyword: 'diretoria', value: 'diretoria'},
            {keyword: 'cliente', value: 'cliente'}
          ];
          
          for (const participant of commonParticipants) {
            if (lowerMessage.includes(participant.keyword)) {
              taskInfo.participants = [participant.value];
              this.logger.log(`Extracted participant from keyword "${participant.keyword}": ${participant.value}`);
              break;
            }
          }
        }

        // Final validation: ensure we have at least action and dateTime
        if (!taskInfo.action && message.toLowerCase().includes('almoço')) {
          taskInfo.action = 'Almoço';
        } else if (!taskInfo.action && (message.toLowerCase().includes('reunião') || message.toLowerCase().includes('reuniao'))) {
          taskInfo.action = 'Reunião';
        }
        
        // Improved time extraction - prioritize time references in update messages
        if (!taskInfo.dateTime) {
          // For update messages, look specifically for new time indications
          const lowerMessage = message.toLowerCase();
          
          // Patterns like "agora às 12h" or "será às 12h" or "não 13h, mas Y"
          const updateTimePatterns = [
            /agora\s+[àa]s?\s+(\d{1,2})[:.h](\d{0,2})/i,
            /ser[áa]\s+[àa]s?\s+(\d{1,2})[:.h](\d{0,2})/i,
            /n[ãa]o\s+(\d{1,2})[:.h](\d{0,2}),?\s+mas\s+(\d{1,2})[:.h](\d{0,2})/i,
            /mudou\s+para\s+(\d{1,2})[:.h](\d{0,2})/i,
            /alterado\s+para\s+(\d{1,2})[:.h](\d{0,2})/i
          ];
          
          for (const pattern of updateTimePatterns) {
            const match = lowerMessage.match(pattern);
            if (match) {
              let hours, minutes = 0;
              
              // Handle special case for "não X, mas Y" pattern
              if (pattern.toString().includes('não')) {
                // Use the correct time (the second one)
                hours = parseInt(match[3], 10);
                minutes = match[4] && !isNaN(parseInt(match[4], 10)) ? parseInt(match[4], 10) : 0;
              } else {
                hours = parseInt(match[1], 10);
                minutes = match[2] && !isNaN(parseInt(match[2], 10)) ? parseInt(match[2], 10) : 0;
              }
              
              const today = new Date();
              today.setHours(hours, minutes, 0, 0);
              taskInfo.dateTime = today;
              this.logger.log(`Extracted time from update pattern: ${today.toISOString()}`);
             
              break;
            }
          }
          
          // Last resort: check for time pattern in the message
          if (!taskInfo.dateTime) {
            const timePattern = /(\d{1,2})[:.h]?(\d{0,2})/;
            const match = message.match(timePattern);
            if (match) {
              const hours = parseInt(match[1], 10);
              const minutes = match[2] && !isNaN(parseInt(match[2], 10)) ? parseInt(match[2], 10) : 0;
              const today = new Date();
              today.setHours(hours, minutes, 0, 0);
              taskInfo.dateTime = today;
              this.logger.log(`Last resort time extraction: ${today.toISOString()}`);
            }
          }
        }

        // Final log of all extracted information
        this.logger.log(`Final extracted task information: ${JSON.stringify({
          action: taskInfo.action,
          dateTime: taskInfo.dateTime?.toISOString(),
          location: taskInfo.location,
          participants: taskInfo.participants
        })}`);
        
        return taskInfo;
      } catch (parseError) {
        this.logger.error(`Error parsing OpenAI response: ${parseError.message}`, parseError.stack);
        return null;
      }
    } catch (error) {
      this.logger.error(`Error calling OpenAI API: ${error.message}`, error.stack);
      return null;
    }
  }

  private createPrompt(message: string): string {
    const today = new Date();
    const formattedDate = today.toLocaleDateString('pt-BR');
    const formattedTime = today.toLocaleTimeString('pt-BR');
    
    return `
Extraia informações de compromisso da seguinte mensagem em português. Hoje é ${formattedDate} e o horário atual é ${formattedTime}.
Mensagem: "${message}"

Extraia as seguintes informações e retorne-as como um objeto JSON:

"action": A descrição ou tipo do compromisso (por exemplo, "Almoço", "Reunião", "Consulta")
"dateTime": A data e hora em que o compromisso deve ocorrer (formato ISO)
"location": O local do compromisso (se mencionado)
"participants": Uma matriz de participantes (se mencionados)

Diretrizes para interpretação:

1. COMPROMISSOS: Identifique o tipo de compromisso mencionado na mensagem. Exemplos incluem "almoço", "jantar", "reunião", "consulta", mas não se limite a estes.

2. HORÁRIOS: Interprete os horários conforme mencionados na mensagem. 
   - Para expressões como "às 12h, não às 13h", interprete 12h como o horário correto
   - Para expressões como "será amanhã às 16h e não hoje às 15h", interprete "amanhã às 16h" como correto
   - Extraia o horário exato mencionado pelo usuário, sem assumir valores padrão

3. ATUALIZAÇÕES: Em mensagens de atualização, extraia a NOVA informação correta, não a original.
   Exemplo: "a reunião não será às 15h, mas sim às 16h" → extraia 16h como o horário

4. PARTICIPANTES: Identifique os participantes mencionados na mensagem. Exemplos comuns incluem "família", "equipe", "financeiro", mas não se limite a estes.

5. DATAS: Interprete as datas conforme o contexto da mensagem e o formato brasileiro (DD/MM/AAAA).
   - Para expressões como "07/04", interprete como 7 de abril
   - Para expressões como "dia 07/04", interprete como 7 de abril
   - Para expressões como "07/04/2024", interprete como 7 de abril de 2024
   - Para expressões como "07/04", NÃO assuma que é 4 de julho
   - Para expressões que mencionam apenas dia e mês (ex: "07/04"), considere o ano atual
   - Para expressões relativas como "amanhã", "próxima semana", "daqui a 3 dias", calcule a data correta com base na data atual

6. HORÁRIOS NÃO ESPECIFICADOS: Se a mensagem não mencionar um horário específico, NÃO assuma um horário padrão.
   Em vez disso, retorne null para o campo dateTime e adicione uma flag "needsTimeConfirmation: true"

7. INTERPRETAÇÃO FLEXÍVEL: Adapte sua interpretação ao contexto específico da mensagem. Não aplique regras rígidas, mas considere o significado pretendido pelo usuário.

IMPORTANTE: Extraia as informações exatamente como mencionadas pelo usuário, sem assumir valores padrão ou fazer interpretações rígidas. O objetivo é capturar a intenção do usuário com precisão.
`;
  }
  
  /**
   * Método especializado para análise conversacional completa
   */
  async analyzeConversation(
    message: string,
    conversationHistory: string[],
    userTasks: any[],
    messageTimestamp: string
  ): Promise<any> {
    try {
      this.logger.log(`Analyzing conversation with message: "${message}"`);
      
      // Convert WhatsApp timestamp to Date
      const messageDate = new Date(parseInt(messageTimestamp) * 1000);
      
      // Format tasks for the prompt
      const tasksFormatted = userTasks.map(task => {
        const date = new Date(task.scheduledDate);
        return {
          id: task.id,
          title: task.title,
          date: date.toISOString(),
          formattedDate: date.toLocaleDateString('pt-BR'),
          location: task.location,
          participants: task.participants,
          status: task.status
        };
      }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      
      // Build the prompt with all context
      const prompt = `
Você é um assistente inteligente para gerenciamento de compromissos, como o JARVIS do Homem de Ferro.
Analise a última mensagem do usuário considerando o histórico de conversa e os compromissos existentes.

Data e hora da mensagem: ${messageDate.toLocaleString('pt-BR')}

HISTÓRICO DE CONVERSA (mais recente por último):
${conversationHistory.map((msg, i) => `[${i+1}] ${msg}`).join('\n')}

COMPROMISSOS ATUAIS DO USUÁRIO:
${tasksFormatted.length === 0 ? 'Nenhum compromisso agendado.' : 
  tasksFormatted.map(t => 
    `ID: ${t.id} | "${t.title}" em ${t.formattedDate}${t.location ? ` em ${t.location}` : ''}${t.participants?.length > 0 ? ` com ${t.participants.join(', ')}` : ''}`
  ).join('\n')
}

ÚLTIMA MENSAGEM DO USUÁRIO:
"${message}"

Forneça uma análise completa no formato JSON:
{
  "intent": "create|update|delete|list|query|clarify|other",
  "confidence": 0.0-1.0,
  "referencedTask": {
    "id": "ID da tarefa referenciada ou null",
    "matchReason": "Razão pela qual você identificou este compromisso específico"
  },
  "changes": {
    "title": "Novo título, se houver alteração",
    "scheduledDate": "Nova data ISO, se houver alteração",
    "location": "Novo local, se houver alteração",
    "participants": ["Novos participantes, se houver alteração"]
  },
  "newTaskInfo": {
    "title": "Título do novo compromisso, se for criação",
    "scheduledDate": "Data ISO do novo compromisso, se for criação",
    "location": "Local do novo compromisso, se for criação",
    "participants": ["Participantes do novo compromisso, se for criação"]
  },
  "responseType": "confirmation|clarification|information|suggestion",
  "suggestedResponseText": "Uma sugestão de resposta natural para o usuário"
}

Diretrizes para interpretação:

1. Para atualizações, identifique qual compromisso está sendo referenciado com base no contexto da mensagem.

2. Para atualizações de horário como "não 13h mas 12h", interprete o NOVO horário (12h) conforme mencionado pelo usuário.

3. Para mensagens ambíguas, solicite clarificação específica sobre o que o usuário deseja.

4. Responda como um assistente inteligente e natural, adaptando-se ao estilo de comunicação do usuário.

5. Entenda a linguagem natural do usuário, sem exigir comandos específicos.

6. Em caso de dúvida sobre qual compromisso está sendo referenciado, considere o contexto completo da conversa.

7. Para referências como "o almoço", interprete com base no contexto da conversa e nos compromissos existentes.

8. Para intenções de atualização, como "O almoço será às 12h, não às 13h", interprete a nova informação correta.

9. Use a data e hora da mensagem como referência para interpretar expressões relativas como "amanhã", "hoje", "próxima semana", etc.

10. Para mensagens encaminhadas, considere que o usuário pode querer criar um novo compromisso.

11. Para datas, interprete conforme o formato brasileiro (DD/MM/AAAA) e o contexto da mensagem. Por exemplo, "07/04" deve ser interpretado como 7 de abril, não 4 de julho, a menos que o contexto indique claramente o contrário.

12. Adapte sua interpretação ao contexto específico da mensagem, sem aplicar regras rígidas.

Seu objetivo é compreender a intenção do usuário com precisão, considerando o contexto completo da conversa e os compromissos existentes.
`;
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2
      });

      const content = response.choices[0]?.message?.content;
      this.logger.log(`OpenAI analysis received: ${content}`);
      
      if (!content) {
        throw new Error('No content returned from OpenAI');
      }

      try {
        const analysis = JSON.parse(content);
        this.logger.log(`Parsed analysis: ${JSON.stringify(analysis)}`);
        return analysis;
      } catch (error) {
        this.logger.error(`Error parsing OpenAI response: ${error.message}`, error.stack);
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error in conversation analysis: ${error.message}`, error.stack);
      // Return a default analysis in case of error
      return {
        intent: "clarify",
        confidence: 0.5,
        responseType: "clarification",
        suggestedResponseText: "Não entendi completamente sua solicitação. Pode me dar mais detalhes?"
      };
    }
  }

  /**
   * Método para gerar resposta conversacional
   */
  async generateConversationalResponse(
    analysis: any, 
    updatedTaskInfo?: any
  ): Promise<string> {
    try {
      // Se já temos uma resposta sugerida com alta confiança, use-a
      if (analysis.suggestedResponseText && analysis.confidence > 0.8) {
        return analysis.suggestedResponseText;
      }
      
      // Caso contrário, gerar uma resposta personalizada baseada na intenção e no resultado
      const prompt = `
Como um assistente pessoal amigável e natural (como o JARVIS), formule uma resposta para o usuário.

ANÁLISE DA SOLICITAÇÃO:
${JSON.stringify(analysis, null, 2)}

${updatedTaskInfo ? `INFORMAÇÕES ATUALIZADAS DO COMPROMISSO:
${JSON.stringify(updatedTaskInfo, null, 2)}` : ''}

Diretrizes para a resposta:
1. Seja natural e conversacional, adaptando-se ao estilo de comunicação do usuário
2. Seja conciso mas completo, fornecendo todas as informações relevantes
3. Foque na ação realizada ou na informação solicitada pelo usuário
4. Evite formalidades excessivas como "Seu compromisso foi..."

Responda diretamente, como uma pessoa falaria. Se houve alteração, mencione especificamente o que mudou.
Para atualizações de horário, você pode dizer algo como "Alterei o horário do almoço para 12h" em vez de "Seu compromisso foi atualizado com sucesso".

Sua resposta (apenas o texto da mensagem, sem explicações):
`;
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 150
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content returned from OpenAI');
      }

      return content.trim();
    } catch (error) {
      this.logger.error(`Error generating conversational response: ${error.message}`, error.stack);
      // Retornar uma resposta genérica em caso de erro
      return "Prontinho! Compromisso atualizado conforme solicitado.";
    }
  }

  // Generic method to call OpenAI chat completions
  async callChatCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.5,
        max_tokens: 500
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content returned from OpenAI');
      }

      return content;
    } catch (error) {
      this.logger.error(`Error calling OpenAI: ${error.message}`, error.stack);
      throw error;
    }
  }
}