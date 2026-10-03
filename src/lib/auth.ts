import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/db.js";
import * as schema from "../db/Schema.js";
import { openAPI } from "better-auth/plugins"; 

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg", 
    schema: schema,
  }),

  trustedOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    },
  },
plugins: [openAPI()],
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
      },
      // Channel identity rides on the session so the navbar matches the rest
      // of the app without a second request. `input: false` keeps them out of
      // better-auth's own write paths — PATCH /api/me owns them.
      displayName: {
        type: "string",
        required: false,
        input: false,
      },
      avatarUrl: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
});