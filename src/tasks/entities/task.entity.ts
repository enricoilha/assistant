export class Task {
    id: string;
    userId: string;
    title: string;
    description?: string;
    scheduledDate: Date;
    location?: string;
    participants?: string[];
    status: 'pending' | 'completed' | 'cancelled';
    createdAt: Date;
  }