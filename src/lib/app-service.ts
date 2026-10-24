import { ChatService } from "./chat-service";
import { prisma } from "./db";
import { FriendService } from "./friend-service";
import { NativeAuthService } from "./native-auth";
import { getRealtimeBus } from "./realtime";

type Services = { chat: ChatService; friends: FriendService; nativeAuth: NativeAuthService };

const holder = globalThis as unknown as { kkchatServices?: Services };

function services(): Services {
  if (!holder.kkchatServices) {
    const bus = getRealtimeBus();
    const chat = new ChatService(prisma, bus);
    holder.kkchatServices = {
      chat,
      friends: new FriendService(prisma, bus, chat),
      nativeAuth: new NativeAuthService(prisma, bus),
    };
  }
  return holder.kkchatServices;
}

export function getChatService() {
  return services().chat;
}

export function getFriendService() {
  return services().friends;
}

export function getNativeAuthService() {
  return services().nativeAuth;
}
