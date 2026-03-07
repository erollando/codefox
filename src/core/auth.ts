import { AuthError } from "./errors.js";

export interface AuthContext {
  userId: number;
  chatId: number;
}

export class AccessControl {
  constructor(
    private readonly allowedUserIds: number[],
    private readonly allowedChatIds?: number[]
  ) {}

  assertAuthorized(ctx: AuthContext): void {
    if (!this.allowedUserIds.includes(ctx.userId)) {
      throw new AuthError(`Unauthorized userId ${ctx.userId}`);
    }

    if (this.allowedChatIds && !this.allowedChatIds.includes(ctx.chatId)) {
      throw new AuthError(`Unauthorized chatId ${ctx.chatId}`);
    }
  }
}
