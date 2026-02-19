import { desc, eq } from "drizzle-orm";
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
      ownerTelegramId: bigint;
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
      ownerTelegramId: bigint;
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
  }): Promise<{ sessionString: string; ownerTelegramId: bigint }>;
}

async function getSetupRow() {
  const row = await db.query.setupState.findFirst({
    orderBy: [desc(setupState.id)]
  });

  if (row) {
    return row;
  }

  const inserted = await db
    .insert(setupState)
    .values({
      status: "not_configured",
      requiresPassword: false,
      updatedAt: new Date()
    })
    .returning();

  return inserted[0];
}

export async function getSetupStatus(_ownerTelegramId?: bigint): Promise<SetupSummary> {
  const row = await getSetupRow();
  return {
    status: row.status,
    requiresPassword: row.requiresPassword
  };
}

async function persistConfiguredSession(sessionString: string, ownerTelegramId: bigint): Promise<void> {
  await db
    .insert(mtprotoSessions)
    .values({
      ownerTelegramId,
      sessionString,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: mtprotoSessions.ownerTelegramId,
      set: {
        sessionString,
        updatedAt: new Date()
      }
    });

  const row = await getSetupRow();
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
    .where(eq(setupState.id, row.id));
}

export async function startSetup(
  _ownerTelegramId: bigint | undefined,
  phone: string,
  gateway: SetupGateway
): Promise<StartSetupResult> {
  const row = await getSetupRow();
  if (row.status === "configured") {
    return { status: "configured", requiresPassword: false };
  }

  const code = await gateway.requestCode(phone);
  if (code.status === "already_authorized") {
    await persistConfiguredSession(code.sessionString, code.ownerTelegramId);
    return { status: "configured", requiresPassword: false };
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
    .where(eq(setupState.id, row.id));

  return {
    status: "awaiting_code",
    requiresPassword: false,
    codeType: code.codeType
  };
}

export async function verifySetupCode(
  _ownerTelegramId: bigint | undefined,
  args: { code?: string; password?: string },
  gateway: SetupGateway
): Promise<VerifySetupResult> {
  const row = await getSetupRow();

  if (row.status === "configured") {
    return { success: true, status: "configured" };
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
        .where(eq(setupState.id, row.id));

      return { success: false, status: "awaiting_password" };
    }

    await persistConfiguredSession(result.sessionString, result.ownerTelegramId);
    return { success: true, status: "configured" };
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
  await persistConfiguredSession(result.sessionString, result.ownerTelegramId);
  return { success: true, status: "configured" };
}

export async function resetSetup(_ownerTelegramId?: bigint): Promise<void> {
  await db.delete(mtprotoSessions);
  const row = await getSetupRow();
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
    .where(eq(setupState.id, row.id));
}

export async function getRuntimeOwnerTelegramId(): Promise<bigint> {
  const session = await db.query.mtprotoSessions.findFirst({
    orderBy: [desc(mtprotoSessions.updatedAt)]
  });

  if (!session) {
    throw new Error("No MTProto session found. Complete setup first.");
  }

  return session.ownerTelegramId;
}
