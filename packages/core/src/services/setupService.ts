import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { mtprotoSessions, setupState, type SetupStatus } from "../db/schema";

export type SetupSummary = {
  status: SetupStatus;
  requiresPassword: boolean;
};

export type StartSetupResult = SetupSummary & {
  codeType?: string;
};

export type VerifySetupResult = {
  status: SetupStatus;
  success: boolean;
};

type RequestCodeResult =
  | {
      status: "code_sent";
      phoneCodeHash: string;
      codeType: string;
      authSessionString: string;
    }
  | {
      status: "already_authorized";
      sessionString: string;
    };

type SignInWithCodeResult =
  | {
      success: false;
      requiresPassword: true;
      authSessionString: string;
    }
  | {
      success: true;
      sessionString: string;
    };

export interface SetupGateway {
  requestCode(phone: string): Promise<RequestCodeResult>;
  signInWithCode(args: {
    phone: string;
    phoneCodeHash: string;
    code: string;
    authSessionString: string;
  }): Promise<SignInWithCodeResult>;
  signInWithPassword(args: {
    password: string;
    authSessionString: string;
  }): Promise<{ sessionString: string }>;
}

async function ensureRow(ownerTelegramId: bigint) {
  await db
    .insert(setupState)
    .values({ ownerTelegramId })
    .onConflictDoNothing({ target: setupState.ownerTelegramId });
}

export async function getSetupStatus(ownerTelegramId: bigint): Promise<SetupSummary> {
  await ensureRow(ownerTelegramId);

  const row = await db.query.setupState.findFirst({
    where: eq(setupState.ownerTelegramId, ownerTelegramId)
  });

  if (!row) {
    return { status: "not_configured", requiresPassword: false };
  }

  return {
    status: row.status,
    requiresPassword: row.requiresPassword
  };
}

async function persistConfiguredSession(ownerTelegramId: bigint, sessionString: string): Promise<void> {
  await db
    .insert(mtprotoSessions)
    .values({
      ownerTelegramId,
      sessionString
    })
    .onConflictDoUpdate({
      target: mtprotoSessions.ownerTelegramId,
      set: {
        sessionString,
        updatedAt: new Date()
      }
    });

  await db
    .update(setupState)
    .set({
      status: "configured",
      requiresPassword: false,
      phone: null,
      phoneCodeHash: null,
      authSessionString: null,
      updatedAt: new Date()
    })
    .where(eq(setupState.ownerTelegramId, ownerTelegramId));
}

export async function startSetup(
  ownerTelegramId: bigint,
  phone: string,
  gateway: SetupGateway
): Promise<StartSetupResult> {
  const current = await getSetupStatus(ownerTelegramId);
  if (current.status === "configured") {
    return {
      status: current.status,
      requiresPassword: false
    };
  }

  const code = await gateway.requestCode(phone);

  if (code.status === "already_authorized") {
    await persistConfiguredSession(ownerTelegramId, code.sessionString);
    return {
      status: "configured",
      requiresPassword: false
    };
  }

  await db
    .update(setupState)
    .set({
      status: "awaiting_code",
      phone,
      phoneCodeHash: code.phoneCodeHash,
      authSessionString: code.authSessionString,
      requiresPassword: false,
      updatedAt: new Date()
    })
    .where(eq(setupState.ownerTelegramId, ownerTelegramId));

  return {
    status: "awaiting_code",
    requiresPassword: false,
    codeType: code.codeType
  };
}

export async function verifySetupCode(
  ownerTelegramId: bigint,
  args: {
    code?: string;
    password?: string;
  },
  gateway: SetupGateway
): Promise<VerifySetupResult> {
  const row = await db.query.setupState.findFirst({
    where: eq(setupState.ownerTelegramId, ownerTelegramId)
  });

  if (!row) {
    throw new Error("Setup has not started yet");
  }

  if (row.status === "configured") {
    return {
      success: true,
      status: "configured"
    };
  }

  if (row.status !== "awaiting_code" && row.status !== "awaiting_password") {
    throw new Error("Setup is not waiting for verification");
  }

  if (row.status === "awaiting_code") {
    if (!row.phone || !row.phoneCodeHash || !row.authSessionString) {
      throw new Error("Setup state is incomplete. Start setup again.");
    }

    if (!args.code) {
      throw new Error("Verification code is required");
    }

    const result = await gateway.signInWithCode({
      phone: row.phone,
      phoneCodeHash: row.phoneCodeHash,
      code: args.code,
      authSessionString: row.authSessionString
    });

    if (!result.success) {
      await db
        .update(setupState)
        .set({
          status: "awaiting_password",
          requiresPassword: true,
          authSessionString: result.authSessionString,
          updatedAt: new Date()
        })
        .where(eq(setupState.ownerTelegramId, ownerTelegramId));

      return {
        success: false,
        status: "awaiting_password"
      };
    }

    await persistConfiguredSession(ownerTelegramId, result.sessionString);

    return {
      success: true,
      status: "configured"
    };
  }

  if (!row.authSessionString) {
    throw new Error("Missing pending authorization session. Restart setup.");
  }

  if (!args.password) {
    throw new Error("2FA password is required");
  }

  const result = await gateway.signInWithPassword({
    password: args.password,
    authSessionString: row.authSessionString
  });

  await persistConfiguredSession(ownerTelegramId, result.sessionString);

  return {
    success: true,
    status: "configured"
  };
}

export async function resetSetup(ownerTelegramId: bigint): Promise<void> {
  await db.delete(mtprotoSessions).where(eq(mtprotoSessions.ownerTelegramId, ownerTelegramId));
  await db
    .update(setupState)
    .set({
      status: "not_configured",
      phone: null,
      phoneCodeHash: null,
      authSessionString: null,
      requiresPassword: false,
      updatedAt: new Date()
    })
    .where(eq(setupState.ownerTelegramId, ownerTelegramId));
}
