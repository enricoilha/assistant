import { Test, TestingModule } from '@nestjs/testing';
import { ConversationService } from './conversation.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ConversationState } from './entities/conversation-state.entity';

describe('ConversationService', () => {
  let service: ConversationService;
  let supabaseService: SupabaseService;
  
  // Mock phone number for tests
  const mockPhoneNumber = '5511999999999';
  
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        {
          provide: SupabaseService,
          useValue: {
            client: {
              from: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnThis(),
                insert: jest.fn().mockReturnThis(),
                update: jest.fn().mockReturnThis(),
                delete: jest.fn().mockReturnThis(),
                eq: jest.fn().mockReturnThis(),
                order: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                maybeSingle: jest.fn().mockReturnValue({
                  data: { id: 'conversation-state-id' },
                  error: null
                }),
                single: jest.fn().mockImplementation(() => {
                  // Default mock for successful response
                  return {
                    data: {
                      state: ConversationState.COLLECTING_INFO,
                      task_data: { fullText: ['Hello'] },
                      last_update_time: new Date().toISOString()
                    },
                    error: null
                  };
                })
              })
            }
          }
        }
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
    supabaseService = module.get<SupabaseService>(SupabaseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
  
  describe('getConversationState', () => {
    it('should retrieve a conversation state', async () => {
      const result = await service.getConversationState(mockPhoneNumber);
      
      expect(result).toBeDefined();
      expect(result).toHaveProperty('state', ConversationState.COLLECTING_INFO);
      expect(result).toHaveProperty('taskData');
      expect(result.taskData).toHaveProperty('fullText');
      expect(result.taskData.fullText).toContain('Hello');
      expect(result).toHaveProperty('lastUpdateTime');
      expect(result.lastUpdateTime instanceof Date).toBeTruthy();
    });
    
    it('should return null if no state is found', async () => {
      // Override the mock for this test to simulate no data found
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockReturnValueOnce({
          data: null,
          error: { code: 'PGRST116' } // This is the "no rows returned" error code
        })
      } as any);
      
      const result = await service.getConversationState(mockPhoneNumber);
      
      expect(result).toBeNull();
    });
    
    it('should handle database errors', async () => {
      // Override the mock for this test to simulate a database error
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockReturnValueOnce({
          data: null,
          error: { code: 'SOME_ERROR', message: 'Database error' }
        })
      } as any);
      
      // The service should catch the error and return null
      const result = await service.getConversationState(mockPhoneNumber);
      expect(result).toBeNull();
    });
  });
  
  describe('saveConversationState', () => {
    it('should update an existing conversation state', async () => {
      const context = {
        state: ConversationState.CONFIRMING,
        taskData: {
          action: 'Almoço',
          dateTime: new Date(),
          fullText: ['Almoço amanhã às 12h']
        },
        lastUpdateTime: new Date()
      };
      
      // Setup mock for the update operation
      const updateMock = jest.fn().mockReturnValue({
        error: null
      });
      
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockReturnValueOnce({
          data: { id: 'existing-id' },
          error: null
        }),
        update: jest.fn().mockImplementation(() => {
          return {
            eq: jest.fn().mockReturnValue(updateMock())
          };
        })
      } as any);
      
      await service.saveConversationState(mockPhoneNumber, context);
      
      // Verify that the client.from was called with the right table
      expect(supabaseService.client.from).toHaveBeenCalledWith('conversation_states');
    });
    
    it('should insert a new conversation state if none exists', async () => {
      const context = {
        state: ConversationState.COLLECTING_INFO,
        taskData: {
          fullText: ['New message']
        },
        lastUpdateTime: new Date()
      };
      
      // Setup mock for the insert operation
      const insertMock = jest.fn().mockReturnValue({
        error: null
      });
      
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockReturnValueOnce({
          data: null,
          error: null
        }),
        insert: jest.fn().mockReturnValue(insertMock)
      } as any);
      
      await service.saveConversationState(mockPhoneNumber, context);
      
      // Verify that the client.from was called with the right table
      expect(supabaseService.client.from).toHaveBeenCalledWith('conversation_states');
    });
    
    it('should handle errors when checking for existing state', async () => {
      const context = {
        state: ConversationState.COLLECTING_INFO,
        taskData: {},
        lastUpdateTime: new Date()
      };
      
      // Setup mock for the check operation to simulate an error
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockReturnValueOnce({
          data: null,
          error: { message: 'Database error' }
        })
      } as any);
      
      await expect(service.saveConversationState(mockPhoneNumber, context))
        .rejects.toHaveProperty('message');
    });
    
    it('should handle errors during update', async () => {
      const context = {
        state: ConversationState.CONFIRMING,
        taskData: {},
        lastUpdateTime: new Date()
      };
      
      // Setup mock for the update operation to simulate an error
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockReturnValueOnce({
          data: { id: 'existing-id' },
          error: null
        }),
        update: jest.fn().mockImplementation(() => {
          return {
            eq: jest.fn().mockReturnValue({
              error: { message: 'Update error' }
            })
          };
        })
      } as any);
      
      await expect(service.saveConversationState(mockPhoneNumber, context))
        .rejects.toHaveProperty('message');
    });
  });
  
  describe('clearConversationState', () => {
    it('should delete a conversation state', async () => {
      // Setup mock for the delete operation
      const deleteMock = jest.fn().mockReturnValue({
        error: null
      });
      
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        delete: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue(deleteMock())
        })
      } as any);
      
      await service.clearConversationState(mockPhoneNumber);
      
      // Verify that the client.from was called with the right table
      expect(supabaseService.client.from).toHaveBeenCalledWith('conversation_states');
    });
    
    it('should handle errors during deletion', async () => {
      // Setup mock for the delete operation to simulate an error
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        delete: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            error: { message: 'Delete error' }
          })
        })
      } as any);
      
      await expect(service.clearConversationState(mockPhoneNumber))
        .rejects.toHaveProperty('message');
    });
  });
  
  describe('isConversationStale', () => {
    it('should return true for conversations older than 30 minutes', () => {
      const oldDate = new Date();
      oldDate.setMinutes(oldDate.getMinutes() - 31); // 31 minutes ago
      
      const context = {
        state: ConversationState.COLLECTING_INFO,
        taskData: {},
        lastUpdateTime: oldDate
      };
      
      const result = service.isConversationStale(context);
      
      expect(result).toBeTruthy();
    });
    
    it('should return false for conversations less than 30 minutes old', () => {
      const recentDate = new Date();
      recentDate.setMinutes(recentDate.getMinutes() - 15); // 15 minutes ago
      
      const context = {
        state: ConversationState.COLLECTING_INFO,
        taskData: {},
        lastUpdateTime: recentDate
      };
      
      const result = service.isConversationStale(context);
      
      expect(result).toBeFalsy();
    });
  });
  
  describe('createInitialContext', () => {
    it('should create a valid initial context', () => {
      const result = service.createInitialContext();
      
      expect(result).toHaveProperty('state', ConversationState.COLLECTING_INFO);
      expect(result).toHaveProperty('taskData');
      expect(result.taskData).toHaveProperty('fullText');
      expect(Array.isArray(result.taskData.fullText)).toBeTruthy();
      expect(result.taskData.fullText.length).toBe(0);
      expect(result).toHaveProperty('lastUpdateTime');
      expect(result.lastUpdateTime instanceof Date).toBeTruthy();
      
      // Should be a recent timestamp (within the last second)
      const now = new Date();
      const timeDiff = now.getTime() - result.lastUpdateTime.getTime();
      expect(timeDiff).toBeLessThan(1000);
    });
  });
  
  describe('saveConversationHistory', () => {
    it('should save conversation history to database', async () => {
      const messages = [
        { role: 'user', content: 'Hello', timestamp: new Date() },
        { role: 'assistant', content: 'Hi there', timestamp: new Date() }
      ];
      
      // Correctly reset the spy for this test
      jest.spyOn(supabaseService.client, 'from').mockReset();
      
      // Setup mock for the insert operation
      const insertMock = jest.fn().mockReturnValue({
        error: null
      });
      
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        insert: insertMock
      } as any);
      
      await service.saveConversationHistory(mockPhoneNumber, messages);
      
      // Verify that the client.from was called with the right table
      expect(supabaseService.client.from).toHaveBeenCalledWith('conversation_history');
      expect(insertMock).toHaveBeenCalled();
    });
    
    it('should handle errors gracefully without throwing', async () => {
      const messages = [
        { role: 'user', content: 'Hello', timestamp: new Date() }
      ];
      
      // Setup mock for the insert operation to simulate an error
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        insert: jest.fn().mockReturnValue({
          error: { message: 'Insert error' }
        })
      } as any);
      
      // Should not throw error, as this is a non-critical operation
      await service.saveConversationHistory(mockPhoneNumber, messages);
      
      // No expect needed, we're just ensuring it doesn't throw
    });
  });
  
  describe('getConversationHistory', () => {
    it('should retrieve conversation history from database', async () => {
      const mockMessages = [
        { role: 'user', content: 'Hello', timestamp: new Date() },
        { role: 'assistant', content: 'Hi there', timestamp: new Date() }
      ];
      
      // Setup mock for the select operation
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        single: jest.fn().mockReturnValue({
          data: { messages: mockMessages },
          error: null
        })
      } as any);
      
      const result = await service.getConversationHistory(mockPhoneNumber);
      
      // Verify that the client.from was called with the right table
      expect(supabaseService.client.from).toHaveBeenCalledWith('conversation_history');
      expect(result).toEqual(mockMessages);
    });
    
    it('should return empty array if no history is found', async () => {
      // Setup mock for the select operation to simulate no data found
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        single: jest.fn().mockReturnValue({
          data: null,
          error: { code: 'PGRST116' }
        })
      } as any);
      
      const result = await service.getConversationHistory(mockPhoneNumber);
      
      expect(result).toEqual([]);
    });
    
    it('should handle database errors and return empty array', async () => {
      // Setup mock for the select operation to simulate a database error
      jest.spyOn(supabaseService.client, 'from').mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        single: jest.fn().mockReturnValue({
          data: null,
          error: { message: 'Database error' }
        })
      } as any);
      
      // Should return empty array rather than throwing
      const result = await service.getConversationHistory(mockPhoneNumber);
      expect(result).toEqual([]);
    });
  });
});