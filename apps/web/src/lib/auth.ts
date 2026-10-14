import {
  authSchema,
  provisionPersonalWorkspace,
  requireWebBindings,
  type D1DatabaseLike,
  type MortemWebBindings,
} from "@mortem/core";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";

export interface PasswordResetNotice {
  userId: string;
  email: string;
  url: string;
  token: string;
}

export interface CreateMortemAuthOptions {
  d1: D1DatabaseLike;
  env?: Partial<MortemWebBindings>;
  requestOrigin?: string;
  onPasswordResetIssued?: (notice: PasswordResetNotice) => void | Promise<void>;
}

const FALLBACK_DEV_SECRET =
  "mortem-local-dev-secret-key-at-least-32-chars-long";

export function resolveAuthSecret(env?: Partial<MortemWebBindings>): string {
  const fromEnv =
    env?.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET ?? "";
  if (fromEnv.trim().length >= 32) {
    return fromEnv.trim();
  }
  return FALLBACK_DEV_SECRET;
}

export function resolveAuthBaseUrl(
  env?: Partial<MortemWebBindings>,
  requestOrigin?: string,
): string {
  const configured = env?.BETTER_AUTH_URL ?? process.env.BETTER_AUTH_URL ?? "";
  if (configured.trim()) {
    return configured.trim();
  }
  if (requestOrigin) {
    return requestOrigin;
  }
  return "http://127.0.0.1:3000";
}

export function createMortemAuth(options: CreateMortemAuthOptions) {
  const { d1, env, requestOrigin, onPasswordResetIssued } = options;
  const db = drizzle(d1 as unknown as Parameters<typeof drizzle>[0], {
    schema: authSchema,
  });

  const googleClientId =
    env?.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? "";
  const googleClientSecret =
    env?.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? "";

  return betterAuth({
    secret: resolveAuthSecret(env),
    baseURL: resolveAuthBaseUrl(env, requestOrigin),
    trustedOrigins: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "https://mortem.somtochukwu-ike.workers.dev",
      ...(requestOrigin ? [requestOrigin] : []),
    ],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
      transaction: false,
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      async sendResetPassword({ user, url, token }) {
        if (onPasswordResetIssued) {
          await onPasswordResetIssued({
            userId: user.id,
            email: user.email,
            url,
            token,
          });
        }
      },
    },
    socialProviders:
      googleClientId && googleClientSecret
        ? {
            google: {
              clientId: googleClientId,
              clientSecret: googleClientSecret,
            },
          }
        : undefined,
    user: {
      additionalFields: {
        defaultWorkspaceId: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 24 hours
      additionalFields: {
        activeWorkspaceId: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await provisionPersonalWorkspace(d1, {
              id: user.id,
              name: user.name,
              email: user.email,
            });
          },
        },
      },
    },
  });
}

export type MortemAuth = ReturnType<typeof createMortemAuth>;

export async function resolveWebD1AndEnv(): Promise<{
  d1: D1DatabaseLike;
  env: Partial<MortemWebBindings>;
}> {
  const { env } = await getCloudflareContext({ async: true });
  const rawEnv = env as unknown as MortemWebBindings;
  const validated = requireWebBindings(rawEnv);
  return {
    d1: validated.DB,
    env: rawEnv,
  };
}

export async function getRequestAuth(request?: Request): Promise<{
  auth: MortemAuth;
  d1: D1DatabaseLike;
  env: Partial<MortemWebBindings>;
}> {
  const { d1, env } = await resolveWebD1AndEnv();
  const requestOrigin = request ? new URL(request.url).origin : undefined;
  const auth = createMortemAuth({ d1, env, requestOrigin });
  return { auth, d1, env };
}
