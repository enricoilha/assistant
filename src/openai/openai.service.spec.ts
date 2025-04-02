import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenaiService } from './openai.service';

// Create a proper OpenAI mock
const mockOpenAI = {
  chat: {
    completions: {
      create: jest.fn()
    }
  }
};

// Mock the OpenAI module
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => mockOpenAI)
  };
});

describe('OpenaiService', () => {
  let service: OpenaiService;
  let configService: ConfigService;

  beforeEach(async () => {
    // Reset the mocks before each test
    mockOpenAI.chat.completions.create.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenaiService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'OPENAI_API_KEY') return 'test-api-key';
              return null;
            })
          }
        }
      ],
    }).compile();

    service = module.get<OpenaiService>(OpenaiService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
  
  describe('detectCrudIntent', () => {
    it('should detect an update intent', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              operation: 'update',
              confidence: 0.9,
              taskId: 'task-1',
              updateInfo: {
                dateTime: '2025-04-02T12:00:00Z'
              }
            })
          }
        }]
      });
      
      const message = 'O almoço com a família amanhã será 12, não 13:00';
      
      const result = await service.detectCrudIntent(message);
      
      expect(result.operation).toBe('update');
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.taskId).toBe('task-1');
      expect(result.updateInfo).toHaveProperty('dateTime');
    });
    
    it('should detect a create intent', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              operation: 'create',
              confidence: 0.9
            })
          }
        }]
      });
      
      const message = 'Marcar reunião amanhã às 15h';
      
      const result = await service.detectCrudIntent(message);
      
      expect(result.operation).toBe('create');
      expect(result.confidence).toBeGreaterThan(0.5);
    });
    
    it('should handle API errors gracefully', async () => {
      // Mock a failure in the OpenAI API
      mockOpenAI.chat.completions.create.mockRejectedValueOnce(new Error('API Error'));
      
      const message = 'Test message';
      
      const result = await service.detectCrudIntent(message);
      
      expect(result.operation).toBe('none');
      expect(result.confidence).toBe(0);
    });
  });
  
  describe('extractTaskInformation', () => {
    it('should extract information from a message about lunch', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'Almoço',
              dateTime: '2025-04-02T12:00:00Z',
              location: 'Restaurante',
              participants: ['família']
            })
          }
        }]
      });
      
      const message = 'Almoço com a família no restaurante às 12h';
      
      const result = await service.extractTaskInformation(message);
      
      expect(result).toHaveProperty('action', 'Almoço');
      expect(result).toHaveProperty('dateTime');
      expect(result.dateTime instanceof Date).toBeTruthy();
      expect(result.dateTime.getHours()).toBe(12);
      expect(result).toHaveProperty('location', 'Restaurante');
      expect(result).toHaveProperty('participants');
      expect(result.participants).toContain('família');
    });
    
    it('should extract information from a message about a meeting', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'Reunião',
              dateTime: '2025-04-02T15:00:00Z'
            })
          }
        }]
      });
      
      const message = 'Reunião às 15h';
      
      const result = await service.extractTaskInformation(message);
      
      expect(result).toHaveProperty('action', 'Reunião');
      expect(result).toHaveProperty('dateTime');
      expect(result.dateTime instanceof Date).toBeTruthy();
      expect(result.dateTime.getHours()).toBe(15);
    });
    
    it('should handle direct time extraction if API returns invalid date', async () => {
      // Mock a response with invalid date format
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'Almoço',
              dateTime: 'invalid-date',
              location: 'Restaurante',
              participants: ['família']
            })
          }
        }]
      });
      
      const message = 'Almoço às 12h';
      
      const result = await service.extractTaskInformation(message);
      
      // Should still extract action
      expect(result).toBeDefined();
      expect(result.action).toBe('Almoço');
    });
    
    it('should handle API errors gracefully', async () => {
      // Mock a failure in the OpenAI API
      mockOpenAI.chat.completions.create.mockRejectedValueOnce(new Error('API Error'));
      
      const message = 'Test message';
      
      const result = await service.extractTaskInformation(message);
      
      expect(result).toBeNull();
    });
  });
  
  describe('analyzeConversation', () => {
    it('should analyze a conversation and identify update intent', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: 'update',
              confidence: 0.95,
              referencedTask: {
                id: 'task-1',
                matchReason: 'Explicit mention of lunch with family'
              },
              changes: {
                scheduledDate: '2025-04-02T12:00:00Z'
              },
              responseType: 'confirmation',
              suggestedResponseText: 'Pronto! Alterei o horário do almoço com a família para 12h.'
            })
          }
        }]
      });
      
      const message = 'O almoço com a família amanhã será 12, não 13:00';
      const conversationHistory = [
        'user: Oi, preciso alterar o horário do almoço amanhã',
        'assistant: Claro, como posso ajudar?'
      ];
      const userTasks = [
        {
          id: 'task-1',
          title: 'Almoço com a família',
          scheduledDate: new Date('2025-04-02T13:00:00Z'),
          location: 'Restaurante',
          participants: ['família'],
          status: 'pending'
        }
      ];
      
      const result = await service.analyzeConversation(
        message,
        conversationHistory,
        userTasks
      );
      
      expect(result).toHaveProperty('intent', 'update');
      expect(result).toHaveProperty('confidence');
      expect(result.confidence).toBeGreaterThan(0.9);
      expect(result).toHaveProperty('referencedTask');
      expect(result.referencedTask).toHaveProperty('id', 'task-1');
      expect(result).toHaveProperty('changes');
      expect(result.changes).toHaveProperty('scheduledDate', '2025-04-02T12:00:00Z');
    });
    
    it('should provide a suggested response text', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: 'update',
              confidence: 0.95,
              referencedTask: {
                id: 'task-1'
              },
              suggestedResponseText: 'Pronto! Alterei o horário do almoço para 12h.'
            })
          }
        }]
      });
      
      const message = 'O almoço com a família amanhã será 12, não 13:00';
      const conversationHistory = ['user: Oi'];
      const userTasks = [
        {
          id: 'task-1',
          title: 'Almoço com a família',
          scheduledDate: new Date('2025-04-02T13:00:00Z')
        }
      ];
      
      const result = await service.analyzeConversation(
        message,
        conversationHistory,
        userTasks
      );
      
      expect(result).toHaveProperty('suggestedResponseText');
      expect(typeof result.suggestedResponseText).toBe('string');
      expect(result.suggestedResponseText.length).toBeGreaterThan(0);
    });
    
    it('should handle API errors gracefully', async () => {
      // Mock a failure in the OpenAI API
      mockOpenAI.chat.completions.create.mockRejectedValueOnce(new Error('API Error'));
      
      const message = 'Test message';
      const conversationHistory = ['user: Test'];
      const userTasks = [];
      
      const result = await service.analyzeConversation(
        message,
        conversationHistory,
        userTasks
      );
      
      expect(result).toHaveProperty('intent', 'clarify');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('responseType', 'clarification');
      expect(result).toHaveProperty('suggestedResponseText');
    });
  });
  
  describe('generateConversationalResponse', () => {
    it('should generate a conversational response based on analysis', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Pronto! Alterei o horário para 12h.'
          }
        }]
      });
      
      const analysis = {
        intent: 'update',
        confidence: 0.7, // Not high enough to use suggested response
        referencedTask: {
          id: 'task-1',
          matchReason: 'Explicit mention'
        },
        changes: {
          scheduledDate: '2025-04-02T12:00:00Z'
        },
        responseType: 'confirmation'
      };
      
      const result = await service.generateConversationalResponse(analysis);
      
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
    
    it('should use the suggested response when confidence is high', async () => {
      const analysis = {
        intent: 'update',
        confidence: 0.95,
        referencedTask: {
          id: 'task-1'
        },
        responseType: 'confirmation',
        suggestedResponseText: 'Esta é a resposta sugerida.'
      };
      
      const result = await service.generateConversationalResponse(analysis);
      
      expect(result).toBe('Esta é a resposta sugerida.');
      
      // Verify the API wasn't called
      expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled();
    });
    
    it('should handle API errors gracefully', async () => {
      // Mock a failure in the OpenAI API
      mockOpenAI.chat.completions.create.mockRejectedValueOnce(new Error('API Error'));
      
      const analysis = {
        intent: 'update',
        confidence: 0.7, // Not high enough to use suggested response
        referencedTask: {
          id: 'task-1'
        }
      };
      
      const result = await service.generateConversationalResponse(analysis);
      
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
  
  describe('callChatCompletion', () => {
    it('should call OpenAI chat completion with the provided prompts', async () => {
      // Setup mock response
      mockOpenAI.chat.completions.create.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Hello, world!'
          }
        }]
      });
      
      const systemPrompt = 'You are a helpful assistant';
      const userPrompt = 'Hello world';
      
      const result = await service.callChatCompletion(systemPrompt, userPrompt);
      
      expect(typeof result).toBe('string');
      expect(result).toBe('Hello, world!');
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: userPrompt
            }
          ]
        })
      );
    });
    
    it('should throw an error when the API fails', async () => {
      // Mock a failure in the OpenAI API
      mockOpenAI.chat.completions.create.mockRejectedValueOnce(new Error('API Error'));
      
      const systemPrompt = 'You are a helpful assistant';
      const userPrompt = 'Hello world';
      
      await expect(service.callChatCompletion(systemPrompt, userPrompt))
        .rejects.toThrow('API Error');
    });
  });
});