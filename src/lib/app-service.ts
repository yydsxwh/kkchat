import { ChatService } from "./chat-service";
import { prisma } from "./db";
import { PrismaChatStore } from "./prisma-store";
import { getRealtimeBus } from "./realtime";

let service: ChatService | null = null;

export function getChatService() {
  if (!service) service = new ChatService(new PrismaChatStore(prisma), getRealtimeBus());
  return service;
}
