import { Test, TestingModule } from '@nestjs/testing';
import { WhatsappService } from './whatsapp.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { OpenaiService } from '../openai/openai.service';
import { TasksService } from '../tasks/tasks.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ConversationService } from './conversation.service';
import { of } from 'rxjs';
import { ConversationState } from './entities/conversation-state.entity';

describe('WhatsappService', () => {
  let service: WhatsappService;
  let openaiService: OpenaiService;
  let tasksService: TasksService;
  let supabaseService: SupabaseService;
  let conversationService: ConversationService;
  let httpService: HttpService;
  
  // Mock data
  const mockPhoneNumberId = 'test-phone-number-id';
  const mockUserPhoneNumber = '5511999999999';
  const mockUserId = 'test-user-id';
  const mockWhatsappApiUrl = 'https://api.whatsapp.com/v1';
  const mockWhatsappToken = 'test-token';
  
  const mockTasks = [
    {
      id: 'task-1',
      userId: mockUserId,
      title: 'Almoço com a família',
      scheduledDate: new Date('2025-04-02T13:00:00Z'),
      location: 'Restaurante',
      participants: ['família'],
      status: 'pending',
      createdAt: new Date('2025-04-01T10:00:00Z')
    },
    {
      id: 'task-2',
      userId: mockUserId,
      title: 'Reunião com financeiro',
      scheduledDate: new Date('2025-04-02T16:00:00Z'),
      location: null,
      participants: ['financeiro'],
      status: 'pending',
      createdAt: new Date('2025-04-01T11:00:00Z')
    }
  ];
  
  // Create mocks for the dependencies
  const createMocks = () => {
    // Mock HttpService post method
    const httpServiceMock = {
      post: jest.fn().mockImplementation(() => {
        return of({ data: { success: true } });
      })
    };
    
    // Mock ConfigService
    const configServiceMock = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'WHATSAPP_API_URL') return mockWhatsappApiUrl;
        if (key === 'WHATSAPP_TOKEN') return mockWhatsappToken;
        if (key === 'WHATSAPP_VERIFY_TOKEN') return 'verify-token';
        return null;
      })
    };
    
    // Mock OpenaiService
    const openaiServiceMock = {
      analyzeConversation: jest.fn().mockResolvedValue({
        intent: 'update',
        confidence: 0.9,
        referencedTask: {
          id: 'task-1',
          matchReason: 'Explicit mention of lunch with family'
        },
        changes: {
          scheduledDate: '2025-04-02T12:00:00Z',
        },
        responseType: 'confirmation',
        suggestedResponseText: 'Pronto! Alterei o horário do almoço com a família para 12h.'
      }),
      detectCrudIntent: jest.fn().mockResolvedValue({
        operation: 'update',
        confidence: 0.9,
        taskId: 'task-1',
        updateInfo: {
          dateTime: new Date('2025-04-02T12:00:00Z')
        }
      }),
      extractTaskInformation: jest.fn().mockResolvedValue({
        action: 'Almoço',
        dateTime: new Date('2025-04-02T12:00:00Z'),
        location: 'Restaurante',
        participants: ['família']
      }),
      generateConversationalResponse: jest.fn().mockResolvedValue('Pronto! Alterei o horário do almoço para 12h.')
    };
    
    // Mock TasksService
    const tasksServiceMock = {
      findAllByUser: jest.fn().mockResolvedValue([...mockTasks]),
      findOne: jest.fn().mockImplementation((id: string) => {
        const task = mockTasks.find(t => t.id === id);
        if (!task) return Promise.reject(new Error('Task not found'));
        return Promise.resolve(task);
      }),
      createTask: jest.fn().mockImplementation((taskData) => {
        return Promise.resolve({
          id: 'new-task-id',
          ...taskData,
          status: 'pending',
          createdAt: new Date()
        });
      }),
      update: jest.fn().mockImplementation((id, updateData) => {
        const task = mockTasks.find(t => t.id === id);
        if (!task) return Promise.reject(new Error('Task not found'));
        
        const updatedTask = {
          ...task,
          ...updateData
        };
        return Promise.resolve(updatedTask);
      }),
      remove: jest.fn().mockResolvedValue(undefined)
    };
    
    // Mock SupabaseService
    const supabaseServiceMock = {
      client: {
        from: jest.fn().mockImplementation((table) => {
          // Different behavior based on the table
          if (table === 'user_settings') {
            return {
              insert: jest.fn().mockReturnValue({
                error: null
              })
            };
          }
          
          return {
            select: jest.fn().mockReturnThis(),
            insert: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            delete: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockReturnValue({
              data: { id: mockUserId },
              error: null
            }),
            maybeSingle: jest.fn().mockReturnValue({
              data: { id: 'conversation-state-id' },
              error: null
            })
          };
        })
      }
    };
    
    // Mock ConversationService
    const conversationServiceMock = {
      getConversationState: jest.fn().mockResolvedValue(null),
      saveConversationState: jest.fn().mockResolvedValue(undefined),
      clearConversationState: jest.fn().mockResolvedValue(undefined),
      isConversationStale: jest.fn().mockReturnValue(false),
      createInitialContext: jest.fn().mockReturnValue({
        state: ConversationState.COLLECTING_INFO,
        taskData: {
          fullText: [],
        },
        lastUpdateTime: new Date(),
      }),
      getConversationHistory: jest.fn().mockResolvedValue([]),
      saveConversationHistory: jest.fn().mockResolvedValue(undefined)
    };
    
    return {
      httpServiceMock,
      configServiceMock,
      openaiServiceMock,
      tasksServiceMock,
      supabaseServiceMock,
      conversationServiceMock
    };
  };
  
  beforeEach(async () => {
    const mocks = createMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        { provide: HttpService, useValue: mocks.httpServiceMock },
        { provide: ConfigService, useValue: mocks.configServiceMock },
        { provide: OpenaiService, useValue: mocks.openaiServiceMock },
        { provide: TasksService, useValue: mocks.tasksServiceMock },
        { provide: SupabaseService, useValue: mocks.supabaseServiceMock },
        { provide: ConversationService, useValue: mocks.conversationServiceMock },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);
    openaiService = module.get<OpenaiService>(OpenaiService);
    tasksService = module.get<TasksService>(TasksService);
    supabaseService = module.get<SupabaseService>(SupabaseService);
    conversationService = module.get<ConversationService>(ConversationService);
    httpService = module.get<HttpService>(HttpService);
    
    // Set up spies for the service methods
    jest.spyOn(service, 'sendMessage').mockResolvedValue();
    jest.spyOn(service, 'getConversationHistory').mockResolvedValue({
      messages: [],
      lastTaskDiscussed: undefined
    });
    jest.spyOn(service, 'addToConversationHistory').mockResolvedValue();
    
    // Add spies for helper methods to avoid actual implementation
    jest.spyOn(service, 'formatDateHumanized').mockImplementation((date) => {
      return 'tomorrow';
    });
    
    jest.spyOn(service, 'formatTimeHumanized').mockImplementation((date) => {
      const hours = date.getHours();
      return `${hours}:00`;
    });
    
    jest.spyOn(service, 'isSameDay').mockImplementation((date1, date2) => {
      return date1.getDate() === date2.getDate() &&
             date1.getMonth() === date2.getMonth() &&
             date1.getFullYear() === date2.getFullYear();
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
  
  describe('getOrCreateUserByPhone', () => {
    it('should return user ID if user exists', async () => {
      const result = await service.getOrCreateUserByPhone(mockUserPhoneNumber);
      expect(result).toBe(mockUserId);
      expect(supabaseService.client.from).toHaveBeenCalledWith('users');
    });
    
    it('should create a new user if user does not exist', async () => {
      // Mock specific responses for creating a new user
      const usersMock = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockReturnValue({
          data: null,
          error: { code: 'PGRST116' }
        }),
        insert: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockReturnValue({
            data: { id: 'new-user-id' },
            error: null
          })
        })
      };
      
      const userSettingsMock = {
        insert: jest.fn().mockReturnValue({
          error: null
        })
      };
      
      jest.spyOn(supabaseService.client, 'from').mockImplementation((table) => {
        if (table === 'users') return usersMock;
        if (table === 'user_settings') return userSettingsMock;
        return null;
      });
      
      const result = await service.getOrCreateUserByPhone(mockUserPhoneNumber);
      
      expect(result).toBe('new-user-id');
      expect(supabaseService.client.from).toHaveBeenCalledWith('users');
      expect(supabaseService.client.from).toHaveBeenCalledWith('user_settings');
      expect(userSettingsMock.insert).toHaveBeenCalled();
    });
  });
  
  describe('processMessageIntelligently', () => {
    it('should process a task update message correctly', async () => {
      const message = 'O almoço com a família amanhã será 12, não 13:00';
      
      await service.processMessageIntelligently(
        mockPhoneNumberId,
        mockUserPhoneNumber,
        mockUserId,
        message
      );
      
      expect(service.addToConversationHistory).toHaveBeenCalledWith(
        mockUserPhoneNumber,
        'user',
        message
      );
      
      expect(tasksService.findAllByUser).toHaveBeenCalledWith(mockUserId);
      
      expect(openaiService.analyzeConversation).toHaveBeenCalled();
      
      expect(service.sendMessage).toHaveBeenCalled();
      
      expect(service.addToConversationHistory).toHaveBeenCalledWith(
        mockUserPhoneNumber,
        'assistant',
        expect.any(String)
      );
    });
  });
  
  describe('handleTaskUpdate', () => {
    it('should update a task and return confirmation message', async () => {
      const analysis = {
        intent: 'update',
        confidence: 0.9,
        referencedTask: {
          id: 'task-1',
          matchReason: 'Explicit mention'
        },
        changes: {
          scheduledDate: '2025-04-02T12:00:00Z'
        }
      };
      
      const result = await service.handleTaskUpdate(
        mockUserId,
        analysis,
        mockTasks
      );
      
      expect(tasksService.update).toHaveBeenCalledWith('task-1', {
        scheduledDate: expect.any(Date)
      });
      
      expect(result).toContain('Pronto!');
      expect(result).toContain('horário');
    });
    
    it('should handle task not found', async () => {
      const analysis = {
        intent: 'update',
        confidence: 0.9,
        referencedTask: {
          id: 'non-existent-task',
          matchReason: 'Explicit mention'
        },
        changes: {
          scheduledDate: '2025-04-02T12:00:00Z'
        }
      };
      
      const result = await service.handleTaskUpdate(
        mockUserId,
        analysis,
        mockTasks
      );
      
      expect(result).toContain('Não encontrei');
    });
    
    it('should handle missing referenced task', async () => {
      const analysis = {
        intent: 'update',
        confidence: 0.9,
        referencedTask: null,
        changes: {
          scheduledDate: '2025-04-02T12:00:00Z'
        }
      };
      
      const result = await service.handleTaskUpdate(
        mockUserId,
        analysis,
        mockTasks
      );
      
      expect(result).toContain('Não consegui identificar');
    });
  });
  
  describe('handleTaskCreation', () => {
    it('should create a new task and return confirmation message', async () => {
      const analysis = {
        intent: 'create',
        confidence: 0.9,
        newTaskInfo: {
          title: 'Jantar',
          scheduledDate: '2025-04-03T19:00:00Z',
          location: 'Restaurante Cura',
          participants: ['família']
        }
      };
      
      const result = await service.handleTaskCreation(
        mockUserId,
        analysis
      );
      
      expect(tasksService.createTask).toHaveBeenCalledWith({
        userId: mockUserId,
        title: 'Jantar',
        scheduledDate: expect.any(Date),
        location: 'Restaurante Cura',
        participants: ['família'],
        description: undefined
      });
      
      expect(result).toContain('Perfeito!');
      expect(result).toContain('Jantar');
    });
    
    it('should handle missing task info', async () => {
      const analysis = {
        intent: 'create',
        confidence: 0.9,
        newTaskInfo: {
          // Missing title and scheduledDate
          location: 'Restaurante'
        }
      };
      
      const result = await service.handleTaskCreation(
        mockUserId,
        analysis
      );
      
      expect(result).toContain('Preciso de mais informações');
    });
  });
  
  describe('handleTaskDeletion', () => {
    it('should delete a task and return confirmation message', async () => {
      const analysis = {
        intent: 'delete',
        confidence: 0.9,
        referencedTask: {
          id: 'task-1',
          matchReason: 'Explicit mention'
        }
      };
      
      const result = await service.handleTaskDeletion(
        mockUserId,
        analysis,
        mockTasks
      );
      
      expect(tasksService.remove).toHaveBeenCalledWith('task-1');
      expect(result).toContain('Pronto!');
      expect(result).toContain('Excluí');
    });
    
    it('should handle task not found', async () => {
      const analysis = {
        intent: 'delete',
        confidence: 0.9,
        referencedTask: {
          id: 'non-existent-task',
          matchReason: 'Explicit mention'
        }
      };
      
      const result = await service.handleTaskDeletion(
        mockUserId,
        analysis,
        mockTasks
      );
      
      expect(result).toContain('Não encontrei');
    });
  });
  
  describe('handleTaskListing', () => {
    it('should list user tasks', async () => {
      const analysis = {
        intent: 'list',
        confidence: 0.9
      };
      
      // Force the mock to create a future date for the tasks
      const futureTasks = mockTasks.map(task => ({
        ...task,
        scheduledDate: new Date(Date.now() + 86400000) // 1 day in the future
      }));
      
      // Override the tasksService.findAllByUser mock for this test
      jest.spyOn(tasksService, 'findAllByUser').mockResolvedValueOnce(futureTasks);
      
      const result = await service.handleTaskListing(
        mockUserId,
        analysis,
        futureTasks
      );
      
      expect(result).toContain('Aqui estão seus próximos compromissos');
    });
    
    it('should handle no tasks', async () => {
      const analysis = {
        intent: 'list',
        confidence: 0.9
      };
      
      const result = await service.handleTaskListing(
        mockUserId,
        analysis,
        []
      );
      
      expect(result).toContain('Você não tem nenhum compromisso');
    });
  });
  
  describe('handleTaskQuery', () => {
    it('should provide information about a specific task', async () => {
      const analysis = {
        intent: 'query',
        confidence: 0.9,
        referencedTask: {
          id: 'task-1',
          matchReason: 'Explicit mention'
        }
      };
      
      const result = await service.handleTaskQuery(
        mockUserId,
        analysis,
        mockTasks
      );
      
      expect(result).toContain('Almoço com a família');
      expect(result).toContain('está agendado');
    });
    
    it('should provide general task information when no specific task is referenced', async () => {
      const analysis = {
        intent: 'query',
        confidence: 0.9,
        referencedTask: null
      };
      
      // Force the mock to create a future date for the tasks
      const futureTasks = mockTasks.map(task => ({
        ...task,
        scheduledDate: new Date(Date.now() + 86400000) // 1 day in the future
      }));
      
      const result = await service.handleTaskQuery(
        mockUserId,
        analysis,
        futureTasks
      );
      
      expect(result).toContain('próximo compromisso');
    });
  });
  
  describe('sendMessage', () => {
    it('should send a message to WhatsApp API', async () => {
      // Reset the mock for this test
      jest.spyOn(service, 'sendMessage').mockRestore();
      
      await service.sendMessage(
        mockPhoneNumberId,
        mockUserPhoneNumber,
        'Test message'
      );
      
      expect(httpService.post).toHaveBeenCalledWith(
        `${mockWhatsappApiUrl}/${mockPhoneNumberId}/messages`,
        expect.objectContaining({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: mockUserPhoneNumber,
          type: 'text'
        }),
        expect.any(Object)
      );
    });
    
    it('should avoid sending duplicate messages', async () => {
      // Reset the mock for this test
      jest.spyOn(service, 'sendMessage').mockRestore();
      
      // Setup history with an existing message
      jest.spyOn(service, 'getConversationHistory').mockResolvedValueOnce({
        messages: [
          {
            role: 'assistant',
            content: 'Duplicate message',
            timestamp: new Date()
          }
        ]
      });
      
      await service.sendMessage(
        mockPhoneNumberId,
        mockUserPhoneNumber,
        'Duplicate message'
      );
      
      // Verify that the API call was not made
      expect(httpService.post).not.toHaveBeenCalled();
    });
  });
  
  describe('verifyWebhook', () => {
    it('should verify valid webhook challenge', () => {
      const mode = 'subscribe';
      const token = 'verify-token';
      const challenge = 'challenge-string';
      
      const result = service.verifyWebhook(mode, token, challenge);
      
      expect(result).toBe(challenge);
    });
    
    it('should throw error for invalid webhook verification', () => {
      const mode = 'subscribe';
      const token = 'invalid-token';
      const challenge = 'challenge-string';
      
      expect(() => {
        service.verifyWebhook(mode, token, challenge);
      }).toThrow('Invalid verification token');
    });
  });
  
  // Helper function tests
  describe('utility functions', () => {
    it('formatDateHumanized should format dates in a natural way', () => {
      // Reset the mock for this test
      jest.spyOn(service, 'formatDateHumanized').mockRestore();
      
      const today = new Date();
      expect(service.formatDateHumanized(today)).toBe('hoje');
      
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(service.formatDateHumanized(tomorrow)).toBe('amanhã');
    });
    
    it('formatTimeHumanized should format times in a natural way', () => {
      // Reset the mock for this test
      jest.spyOn(service, 'formatTimeHumanized').mockRestore();
      
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      expect(service.formatTimeHumanized(noon)).toBe('meio-dia');
      
      const halfPastThree = new Date();
      halfPastThree.setHours(3, 30, 0, 0);
      expect(service.formatTimeHumanized(halfPastThree)).toBe('3 e meia');
    });
    
    it('isSameDay should correctly compare dates', () => {
      // Reset the mock for this test
      jest.spyOn(service, 'isSameDay').mockRestore();
      
      const date1 = new Date('2025-04-01T10:00:00Z');
      const date2 = new Date('2025-04-01T18:00:00Z');
      const date3 = new Date('2025-04-02T10:00:00Z');
      
      expect(service.isSameDay(date1, date2)).toBeTruthy();
      expect(service.isSameDay(date1, date3)).toBeFalsy();
    });
  });
});