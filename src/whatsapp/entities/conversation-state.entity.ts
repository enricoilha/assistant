export enum ConversationState {
  INITIAL = 'initial',
  COLLECTING_INFO = 'collecting_info',
  CONFIRMING = 'confirming',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  LISTING_TASKS = 'listing_tasks',
  UPDATING_TASK = 'updating_task',
  DELETING_TASK = 'deleting_task',
  SELECTING_TASK = 'selecting_task'
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
}