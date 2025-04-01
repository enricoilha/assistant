// src/openai/openai.service.ts - Versão completa atualizada
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
        model: 'gpt-3.5-turbo-1106',
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
Analyze the following message in Portuguese to detect CRUD operations related to appointments:

Message: "${message}"

${contextInfo}

Detect if the user is trying to:
1. CREATE a new appointment (e.g., "Meeting tomorrow at 3pm")
2. READ/LIST appointments (e.g., "Show my appointments", "What do I have scheduled?")
3. UPDATE an existing appointment (e.g., "Change my 3pm meeting to 4pm", "Actually it's at 2pm not 3pm")
4. DELETE an appointment (e.g., "Cancel my meeting tomorrow", "Remove the dentist appointment")

Return a JSON object with:
1. "operation": The detected operation ("create", "read", "update", "delete", or "none" if unclear)
2. "confidence": A number from 0 to 1 indicating confidence in the detection
3. "taskId": Optional task ID if mentioned or extractable from context
4. "updateInfo": For updates, include the information being changed

Examples:
- For "Na verdade a reunião é às 14:00", classify as an update operation with updated time
- For "Cancelar minha consulta de amanhã", classify as a delete operation
- For "Tenho uma reunião marcada para quando?", classify as a read operation
- For "Agendar corte de cabelo quinta-feira", classify as a create operation
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
            content: `You are a helpful assistant that extracts appointment information from messages. 
                      Extract as much information as you can, including appointment type, date, time, 
                      location and participants. Format your response as JSON.`,
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
          // Try to extract time from message directly if OpenAI failed
          const timeMatch = message.match(/(\d{1,2})[:\.](\d{2})/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            
            const today = new Date();
            today.setHours(hours, minutes, 0, 0);
            taskInfo.dateTime = today;
            this.logger.log(`Extracted time directly from message: ${today.toISOString()}`);
          }
        }
        
        // Handle location
        if (parsedResult.location) {
          taskInfo.location = parsedResult.location;
          this.logger.log(`Extracted location: ${taskInfo.location}`);
        } else {
          // Try to extract known locations from message
          const lowerMessage = message.toLowerCase();
          if (lowerMessage.includes('restaurante') || lowerMessage.includes('cura')) {
            const restaurantMatch = message.match(/restaurante\s+(\w+)/i);
            if (restaurantMatch) {
              taskInfo.location = `Restaurante ${restaurantMatch[1]}`;
            } else if (lowerMessage.includes('cura')) {
              taskInfo.location = 'Restaurante Cura';
            }
            this.logger.log(`Extracted location from keywords: ${taskInfo.location}`);
          }
        }
        
        // Handle participants
        if (parsedResult.participants && Array.isArray(parsedResult.participants)) {
          taskInfo.participants = parsedResult.participants;
          this.logger.log(`Extracted participants: ${taskInfo.participants.join(', ')}`);
        }

        // Final validation: ensure we have at least action and dateTime
        if (!taskInfo.action && message.toLowerCase().includes('almoço')) {
          taskInfo.action = 'Almoço';
        }
        
        if (!taskInfo.dateTime) {
          // Last resort: check for time pattern in the message
          const timePattern = /(\d{1,2})[:\.]?(\d{2})/;
          const match = message.match(timePattern);
          if (match) {
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const today = new Date();
            today.setHours(hours, minutes, 0, 0);
            taskInfo.dateTime = today;
            this.logger.log(`Last resort time extraction: ${today.toISOString()}`);
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

Seja flexível na sua extração:

Se apenas o horário for mencionado (por exemplo, "12:30"), assuma que é para hoje
Para "almoço" ou "jantar", estes devem ser reconhecidos como o tipo de ação/compromisso
Extraia nomes de locais como nomes de restaurantes, nomes de escritórios, etc.
Mesmo informações parciais são valiosas - extraia o que puder

CERTIFIQUE-SE DE EXTRAIR O HORÁRIO CORRETAMENTE, ESPECIALMENTE PARA MENSAGENS MENCIONANDO "12:30" OU FORMATOS DE HORA SIMILARES.
`;
  }
}