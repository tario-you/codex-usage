import { z } from 'zod'

const rateLimitWindowSchema = z.object({
  resetsAt: z.number().nullable(),
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable(),
})

const creditsSchema = z.object({
  balance: z.string().nullable(),
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
})

const resetCreditsSchema = z.object({
  applicable: z.number().int().nonnegative().nullable(),
  available: z.number().int().nonnegative(),
})

const rateLimitSnapshotSchema = z.object({
  credits: creditsSchema.nullable(),
  resetCredits: resetCreditsSchema.nullish(),
  limitId: z.string().nullable(),
  limitName: z.string().nullable(),
  planType: z.string().nullable(),
  primary: rateLimitWindowSchema.nullable(),
  secondary: rateLimitWindowSchema.nullable(),
})

const chatgptAccountSchema = z.object({
  email: z.string().optional(),
  planType: z.string().optional(),
  type: z.literal('chatgpt'),
})

const apiKeyAccountSchema = z.object({
  type: z.literal('apiKey'),
})

export const accountStateSchema = z.object({
  account: z.union([chatgptAccountSchema, apiKeyAccountSchema, z.null()]),
  requiresOpenaiAuth: z.boolean(),
})

export const rateLimitsSchema = z.object({
  rateLimits: rateLimitSnapshotSchema,
  rateLimitsByLimitId: z
    .record(z.string(), rateLimitSnapshotSchema)
    .nullish(),
})

export const deviceMetadataSchema = z.object({
  codexHome: z.string().nullable().optional(),
  label: z.string().min(1).max(120).optional(),
  machineName: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
