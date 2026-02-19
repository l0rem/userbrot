import { requireMtprotoApiCredentials } from "@userbrot/core/env";
import type { SetupGateway } from "@userbrot/core/services/setupService";
import { MemoryStorage, TelegramClient } from "@mtcute/node";

function createClient() {
  const { apiId, apiHash } = requireMtprotoApiCredentials();

  return new TelegramClient({
    apiId,
    apiHash,
    storage: new MemoryStorage(),
    disableUpdates: true
  });
}

async function withClient<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const client = createClient();
  try {
    return await fn(client);
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "errorMessage" in error) {
    const value = (error as { errorMessage?: unknown }).errorMessage;
    if (typeof value === "string") {
      return value;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isPasswordNeeded(error: unknown): boolean {
  const normalized = getErrorMessage(error).toUpperCase();

  if (normalized.includes("SESSION_PASSWORD_NEEDED") || normalized.includes("PASSWORD_NEEDED")) {
    return true;
  }

  return (
    normalized.includes("2FA IS ENABLED") ||
    (normalized.includes("PASSWORD") && normalized.includes("LOGIN"))
  );
}

export class MtcuteSetupGateway implements SetupGateway {
  async requestCode(phone: string) {
    return withClient(async (client) => {
      const result = await client.sendCode({ phone });
      const authSessionString = await client.exportSession();

      if ("phoneCodeHash" in result && typeof result.phoneCodeHash === "string") {
        return {
          status: "code_sent" as const,
          phoneCodeHash: result.phoneCodeHash,
          codeType: result.type,
          authSessionString
        };
      }

      return {
        status: "already_authorized" as const,
        sessionString: authSessionString,
        ownerTelegramId: BigInt((await client.getMe()).id)
      };
    });
  }

  async signInWithCode(args: {
    phone: string;
    phoneCodeHash: string;
    code: string;
    authSessionString: string;
  }) {
    return withClient(async (client) => {
      await client.importSession(args.authSessionString, true);

      try {
        await client.signIn({
          phone: args.phone,
          phoneCodeHash: args.phoneCodeHash,
          phoneCode: args.code
        });

        const sessionString = await client.exportSession();
        const me = await client.getMe();
        return {
          success: true as const,
          sessionString,
          ownerTelegramId: BigInt(me.id)
        };
      } catch (error) {
        if (isPasswordNeeded(error)) {
          const authSessionString = await client.exportSession();
          return {
            success: false as const,
            requiresPassword: true as const,
            authSessionString
          };
        }

        throw new Error(`Failed to verify code: ${getErrorMessage(error)}`);
      }
    });
  }

  async signInWithPassword(args: { password: string; authSessionString: string }) {
    return withClient(async (client) => {
      await client.importSession(args.authSessionString, true);

      try {
        await client.checkPassword(args.password);
      } catch (error) {
        throw new Error(`Failed to verify password: ${getErrorMessage(error)}`);
      }

      const sessionString = await client.exportSession();
      const me = await client.getMe();
      return { sessionString, ownerTelegramId: BigInt(me.id) };
    });
  }
}

export const setupGateway = new MtcuteSetupGateway();
