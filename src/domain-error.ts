export class DomainError extends Error {
  constructor(message: string, readonly details?: { kind: "running_task"; task_id: string; title: string }) {
    super(message);
  }
}
