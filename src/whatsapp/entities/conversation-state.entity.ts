export enum ConversationState {
  INITIAL = 'initial',
  COLLECTING_INFO = 'collecting_info',
  CONFIRMING = 'confirming',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  LISTING_TASKS = 'listing_tasks',
  UPDATING_TASK = 'updating_task',
  DELETING_TASK = 'deleting_task',
  SELECTING_TASK = 'selecting_task',
  // New intelligent conversation states
  ANALYZING_REQUEST = 'analyzing_request',
  WAITING_FOR_CLARIFICATION = 'waiting_for_clarification',
  CONFIRMING_CONFLICT = 'confirming_conflict'
}

export interface TaskData {
  action?: string;
  dateTime?: Date;
  location?: string;
  participants?: string[];
  fullText?: string[];
  taskId?: string;
}

export interface ConversationContext {
  state: ConversationState;
  taskData: TaskData;
  lastUpdateTime: Date;
  selectedTaskId?: string;
  operation?: 'create' | 'read' | 'update' | 'delete';
  tasks?: any[];
  hasConflict?: boolean;
  pendingUpdate?: any;
  pendingTaskCreation?: {
    title: string;
    scheduledDate: string;
    location?: string;
    participants?: string[];
  };
  lastAnalysis?: {
    intent: string;
    referencedTask?: {
      id: string;
      title?: string;
    };
    confidence: number;
  };
}