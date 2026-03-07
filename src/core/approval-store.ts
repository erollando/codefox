import type { ApprovalRequest } from "../types/domain.js";

export class ApprovalStore {
  private readonly byChatId = new Map<number, ApprovalRequest>();

  constructor(
    initialApprovals: ApprovalRequest[] = [],
    private readonly onChange?: (approvals: ApprovalRequest[]) => void | Promise<void>
  ) {
    for (const approval of initialApprovals) {
      this.byChatId.set(approval.chatId, approval);
    }
  }

  set(request: ApprovalRequest): void {
    this.byChatId.set(request.chatId, request);
    this.emitChange();
  }

  get(chatId: number): ApprovalRequest | undefined {
    return this.byChatId.get(chatId);
  }

  delete(chatId: number): void {
    this.byChatId.delete(chatId);
    this.emitChange();
  }

  list(): ApprovalRequest[] {
    return [...this.byChatId.values()].sort((left, right) => left.chatId - right.chatId);
  }

  private emitChange(): void {
    if (!this.onChange) {
      return;
    }
    const maybePromise = this.onChange(this.list());
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
      void (maybePromise as Promise<void>).catch((error) => {
        console.error(`Failed to persist approvals: ${String(error)}`);
      });
    }
  }
}
